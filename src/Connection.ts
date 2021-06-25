import type { ConnectionProps } from "./ConnectionProps";
import type {
	EmitEventHandler,
	ListenEventHandler,
	SocketClient,
} from "./SocketClient";
import type { GetUserPermissionsCallback } from "./SocketEvents";
import { normalizeHostId, wait } from "./tools";

/** Possible progress states. */
export enum PROGRESS {
	/** The socket is connecting. */
	CONNECTING = 0,
	/** The socket is successfully connected. */
	CONNECTED = 1,
	/** All objects are loaded. */
	OBJECTS_LOADED = 2,
	/** The socket is ready for use. */
	READY = 3,
}

export enum ERRORS {
	PERMISSION_ERROR = "permissionError",
	NOT_CONNECTED = "notConnectedError",
	TIMEOUT = "timeout",
	NOT_ADMIN = "Allowed only in admin",
	NOT_SUPPORTED = "Not supported",
}

/** @deprecated Use {@link ERRORS.PERMISSION_ERROR} instead */
export const PERMISSION_ERROR = ERRORS.PERMISSION_ERROR;
/** @deprecated Use {@link ERRORS.NOT_CONNECTED} instead */
export const NOT_CONNECTED = ERRORS.NOT_CONNECTED;

/** Options to use for the backend request wrapper */
interface RequestOptions<T> {
	/** The key that is used to cache the results for later requests of the same kind */
	cacheKey?: string;
	/** Used to bypass the cache */
	forceUpdate?: boolean;
	/** Can be used to identify the request method in error messages */
	requestName?: string;
	/**
	 * The timeout in milliseconds after which the call will reject with a timeout error.
	 * If no timeout is given, the default is used. Set this to `false` to explicitly disable the timeout.
	 */
	commandTimeout?: number | false;
	/** Will be called when the timeout elapses */
	onTimeout?: () => void;
	/** Whether the call should only be allowed in the admin adapter */
	requireAdmin?: boolean;
	/** Require certain features to be supported for this call */
	requireFeatures?: string[];
	/** The function that does the actual work */
	executor: (
		resolve: (value: T | PromiseLike<T> | Promise<T>) => void,
		reject: (reason?: any) => void,
		/** Can be used to check in the executor whether the request has timed out and/or stop it from timing out */
		timeout: Readonly<{ elapsed: boolean; clearTimeout: () => void }>,
	) => void | Promise<void>;
}

export class Connection<
	CustomListenEvents extends Record<
		keyof CustomListenEvents,
		ListenEventHandler
	> = Record<string, never>,
	CustomEmitEvents extends Record<
		keyof CustomEmitEvents,
		EmitEventHandler
	> = Record<string, never>,
> {
	constructor(props: Partial<ConnectionProps>) {
		this.props = this.applyDefaultProps(props);

		this.autoSubscribes = this.props.autoSubscribes ?? [];
		this.autoSubscribeLog = this.props.autoSubscribeLog ?? false;

		this.doNotLoadAllObjects = this.props.doNotLoadAllObjects ?? true;
		this.doNotLoadACL = this.props.doNotLoadACL ?? true;

		this.states = {};
		this.objects = null;
		this.acl = null;
		this.systemLang = "en";
		this._waitForFirstConnection = new Promise((resolve) => {
			this._waitForFirstConnectionResolve = resolve;
		});

		this.statesSubscribes = {}; // subscribe for states
		this.objectsSubscribes = {}; // subscribe for objects

		this.admin5only = this.props.admin5only || false;

		this.onConnectionHandlers = [];
		this.onLogHandlers = [];

		this._promises = {};
		this.startSocket();
	}

	private applyDefaultProps(
		props: Partial<ConnectionProps>,
	): ConnectionProps {
		return {
			...props,
			// Define default props that always need to be set
			protocol: props.protocol || window.location.protocol,
			host: props.host || window.location.hostname,
			port:
				props.port ||
				(window.location.port === "3000" ? 8081 : window.location.port),
			ioTimeout: Math.max(props.ioTimeout || 20000, 20000),
			cmdTimeout: Math.max(props.cmdTimeout || 5000, 5000),
		};
	}

	private readonly props: ConnectionProps;
	private readonly autoSubscribes: string[];
	private readonly autoSubscribeLog: boolean;

	private readonly doNotLoadAllObjects: boolean;
	private readonly doNotLoadACL: boolean;

	private connected: boolean = false;
	private subscribed: boolean = false;
	private firstConnect: boolean = true;
	public waitForRestart: boolean = false;
	public loaded: boolean = false;
	private scriptLoadCounter: number;

	public statesSubscribes: Record<
		string,
		{ reg: RegExp; cbs: ioBroker.StateChangeHandler[] }
	>;
	public objectsSubscribes: Record<
		string,
		{ reg: RegExp; cbs: ioBroker.ObjectChangeHandler[] }
	>;
	public objects: any;
	public states: Record<string, ioBroker.State>;
	public acl: any;
	public systemLang: ioBroker.Languages;
	public admin5only: any;
	public isSecure: boolean;

	public onConnectionHandlers: ((connected: boolean) => void)[];
	public onLogHandlers: ((message: string) => void)[];

	private onError(error: any): void {
		(this.props.onError ?? console.error)(error);
	}

	private onCmdStdoutHandler?: (id: string, text: string) => void;
	private onCmdStderrHandler?: (id: string, text: string) => void;
	private onCmdExitHandler?: (id: string, exitCode: number) => void;

	protected _socket: SocketClient<CustomListenEvents, CustomEmitEvents>;
	// TODO: type this with a templated index signature https://github.com/microsoft/TypeScript/pull/26797
	protected _promises: Record<string, Promise<any>>;
	protected _authTimer: any;
	protected systemConfig: any;

	private _waitForFirstConnection: Promise<void>;
	private _waitForFirstConnectionResolve?: (
		value: void | PromiseLike<void>,
	) => void;

	/**
	 * Checks if this connection is running in a web adapter and not in an admin.
	 * @returns {boolean} True if running in a web adapter or in a socketio adapter.
	 */
	static isWeb(): boolean {
		return window.socketUrl !== undefined;
	}

	/**
	 * Starts the socket.io connection.
	 */
	startSocket(): void {
		// if socket io is not yet loaded
		if (typeof window.io === "undefined") {
			// if in index.html the onLoad function not defined
			if (typeof window.registerSocketOnLoad !== "function") {
				// poll if loaded
				this.scriptLoadCounter = this.scriptLoadCounter || 0;
				this.scriptLoadCounter++;

				if (this.scriptLoadCounter < 30) {
					// wait till the script loaded
					setTimeout(() => this.startSocket(), 100);
					return;
				} else {
					window.alert("Cannot load socket.io.js!");
				}
			} else {
				// register on load
				window.registerSocketOnLoad(() => this.startSocket());
			}
			return;
		} else {
			// socket was initialized, do not repeat
			if (this._socket) {
				return;
			}
		}

		let host = this.props.host;
		let port = this.props.port;
		let protocol = this.props.protocol.replace(":", "");

		// if web adapter, socket io could be on other port or even host
		if (window.socketUrl) {
			const parsed = new URL(window.socketUrl);
			host = parsed.hostname;
			port = parsed.port;
			protocol = parsed.protocol.replace(":", "");
		}

		const url = `${protocol}://${host}:${port}`;

		this._socket = window.io.connect(url, {
			query: "ws=true",
			name: this.props.name,
			timeout: this.props.ioTimeout,
		});

		this._socket.on("connect", (noTimeout) => {
			// If the user is not admin it takes some time to install the handlers, because all rights must be checked
			if (noTimeout !== true) {
				setTimeout(
					() =>
						this.getVersion().then((info) => {
							const [major, minor, patch] =
								info.version.split(".");
							const v =
								parseInt(major, 10) * 10000 +
								parseInt(minor, 10) * 100 +
								parseInt(patch, 10);
							if (v < 40102) {
								this._authTimer = null;
								// possible this is old version of admin
								this.onPreConnect(false, false);
							} else {
								this._socket.emit(
									"authenticate",
									(isOk, isSecure) =>
										this.onPreConnect(isOk, isSecure),
								);
							}
						}),
					500,
				);
			} else {
				// iobroker websocket waits, till all handlers are installed
				this._socket.emit("authenticate", (isOk, isSecure) => {
					this.onPreConnect(isOk, isSecure);
				});
			}
		});

		this._socket.on("reconnect", () => {
			this.props.onProgress?.(PROGRESS.READY);
			this.connected = true;

			if (this.waitForRestart) {
				window.location.reload();
			} else {
				this._subscribe(true);
				this.onConnectionHandlers.forEach((cb) => cb(true));
			}
		});

		this._socket.on("disconnect", () => {
			this.connected = false;
			this.subscribed = false;
			this.props.onProgress?.(PROGRESS.CONNECTING);
			this.onConnectionHandlers.forEach((cb) => cb(false));
		});

		this._socket.on("reauthenticate", () => this.authenticate());

		this._socket.on("log", (message) => {
			this.props.onLog?.(message);
			this.onLogHandlers.forEach((cb) => cb(message));
		});

		this._socket.on("error", (err: any) => {
			let _err: string;

			if (err == undefined) {
				_err = "";
			} else if (typeof err.toString !== "function") {
				_err = err.toString();
			} else {
				_err = JSON.stringify(err);
				console.error(`Received strange error: ${_err}`);
			}

			if (_err.includes("User not authorized")) {
				this.authenticate();
			} else {
				window.alert(`Socket Error: ${err}`);
			}
		});

		this._socket.on("connect_error", (err: any) =>
			console.error(`Connect error: ${err}`),
		);

		this._socket.on("permissionError", (err) =>
			this.onError({
				message: "no permission",
				operation: err.operation,
				type: err.type,
				id: err.id || "",
			}),
		);

		this._socket.on("objectChange", (id, obj) => {
			setTimeout(() => this.objectChange(id, obj), 0);
		});

		this._socket.on("stateChange", (id, state) => {
			setTimeout(() => this.stateChange(id, state), 0);
		});

		this._socket.on("cmdStdout", (id, text) => {
			this.onCmdStdoutHandler?.(id, text);
		});

		this._socket.on("cmdStderr", (id, text) => {
			this.onCmdStderrHandler?.(id, text);
		});

		this._socket.on("cmdExit", (id, exitCode) => {
			this.onCmdExitHandler?.(id, exitCode);
		});
	}

	/**
	 * Called internally.
	 * @param isOk
	 * @param isSecure
	 */
	private onPreConnect(isOk: boolean, isSecure: boolean) {
		if (this._authTimer) {
			clearTimeout(this._authTimer);
			this._authTimer = null;
		}

		this.connected = true;
		this.isSecure = isSecure;

		if (this.waitForRestart) {
			window.location.reload();
		} else {
			if (this.firstConnect) {
				this.loadData();
			} else {
				this.props.onProgress?.(PROGRESS.READY);
			}

			this._subscribe(true);
			this.onConnectionHandlers.forEach((cb) => cb(true));
		}

		if (this._waitForFirstConnectionResolve) {
			this._waitForFirstConnectionResolve();
			this._waitForFirstConnectionResolve = undefined;
		}
	}

	/**
	 * Checks if the socket is connected.
	 * @returns {boolean} true if connected.
	 */
	isConnected(): boolean {
		return this.connected;
	}

	/**
	 * Checks if the socket is connected.
	 * @returns {Promise<void>} Promise resolves if once connected.
	 */
	waitForFirstConnection(): Promise<void> {
		return this._waitForFirstConnection;
	}

	/**
	 * Called internally.
	 */
	private _getUserPermissions(cb?: GetUserPermissionsCallback) {
		if (this.doNotLoadACL) {
			cb?.();
		} else {
			this._socket.emit("getUserPermissions", cb);
		}
	}

	/** Loads the important data and retries a couple of times if it takes too long */
	private async loadData(): Promise<void> {
		if (this.loaded) return;
		const maxAttempts = 10;
		for (let i = 1; i <= maxAttempts; i++) {
			this.onConnect();
			await wait(1000);
			if (this.loaded) return;
		}
	}

	/**
	 * Called internally.
	 */
	private onConnect() {
		this._getUserPermissions((err, acl) => {
			if (err) {
				return this.onError(`Cannot read user permissions: ${err}`);
			} else if (!this.doNotLoadACL) {
				if (this.loaded) {
					return;
				}
				this.loaded = true;

				this.props.onProgress?.(PROGRESS.CONNECTED);
				this.firstConnect = false;

				this.acl = acl;
			}

			// Read system configuration
			return (
				this.admin5only && !Connection.isWeb()
					? this.getCompactSystemConfig()
					: this.getSystemConfig()
			)
				.then((data) => {
					if (this.doNotLoadACL) {
						if (this.loaded) {
							return undefined;
						}
						this.loaded = true;

						this.props.onProgress?.(PROGRESS.CONNECTED);
						this.firstConnect = false;
					}

					this.systemConfig = data;
					if (this.systemConfig && this.systemConfig.common) {
						this.systemLang = this.systemConfig.common.language;
					} else {
						this.systemLang =
							<any>window.navigator.userLanguage ||
							window.navigator.language;

						if (
							this.systemLang !== "en" &&
							this.systemLang !== "de" &&
							this.systemLang !== "ru"
						) {
							this.systemConfig.common.language = "en";
							this.systemLang = "en";
						}
					}

					this.props.onLanguage &&
						this.props.onLanguage(<any>this.systemLang);

					if (!this.doNotLoadAllObjects) {
						return this.getObjects().then(() => {
							this.props.onProgress?.(PROGRESS.READY);
							this.props.onReady &&
								this.props.onReady(this.objects);
						});
					} else {
						this.objects = this.admin5only
							? {}
							: { "system.config": data };
						this.props.onProgress?.(PROGRESS.READY);
						this.props.onReady?.(this.objects);
					}
					return undefined;
				})
				.catch((e) => this.onError(`Cannot read system config: ${e}`));
		});
	}

	/**
	 * Called internally.
	 */
	private authenticate() {
		if (window.location.search.includes("&href=")) {
			window.location = <any>(
				`${window.location.protocol}//${window.location.host}${window.location.pathname}${window.location.search}${window.location.hash}`
			);
		} else {
			window.location = <any>(
				`${window.location.protocol}//${window.location.host}${window.location.pathname}?login&href=${window.location.search}${window.location.hash}`
			);
		}
	}

	/**
	 * Subscribe to changes of the given state.
	 * @param id The ioBroker state ID.
	 * @param cb The callback.
	 */
	/**
	 * Subscribe to changes of the given state.
	 * @param id The ioBroker state ID.
	 * @param binary Set to true if the given state is binary and requires Base64 decoding.
	 * @param cb The callback.
	 */
	subscribeState(
		id: string,
		binary: ioBroker.StateChangeHandler | boolean,
		cb: ioBroker.StateChangeHandler,
	): void {
		if (typeof binary === "function") {
			cb = binary;
			binary = false;
		}

		if (!this.statesSubscribes[id]) {
			let reg = id
				.replace(/\./g, "\\.")
				.replace(/\*/g, ".*")
				.replace(/\(/g, "\\(")
				.replace(/\)/g, "\\)")
				.replace(/\+/g, "\\+")
				.replace(/\[/g, "\\[");

			if (reg.indexOf("*") === -1) {
				reg += "$";
			}
			this.statesSubscribes[id] = { reg: new RegExp(reg), cbs: [] };
			this.statesSubscribes[id].cbs.push(cb);
			if (this.connected) {
				this._socket.emit("subscribe", id);
			}
		} else {
			!this.statesSubscribes[id].cbs.includes(cb) &&
				this.statesSubscribes[id].cbs.push(cb);
		}
		if (typeof cb === "function" && this.connected) {
			if (binary) {
				this.getBinaryState(id)
					.then((base64) => cb(id, <any>base64))
					.catch((e) =>
						console.error(
							`Cannot getForeignStates "${id}": ${JSON.stringify(
								e,
							)}`,
						),
					);
			} else {
				this._socket.emit("getForeignStates", id, (err, states) => {
					err &&
						console.error(
							`Cannot getForeignStates "${id}": ${JSON.stringify(
								err,
							)}`,
						);
					states &&
						Object.keys(states).forEach((id) => cb(id, states[id]));
				});
			}
		}
	}

	/**
	 * Unsubscribes all callbacks from changes of the given state.
	 * @param id The ioBroker state ID.
	 */
	/**
	 * Unsubscribes the given callback from changes of the given state.
	 * @param id The ioBroker state ID.
	 * @param cb The callback.
	 */
	unsubscribeState(id: string, cb?: ioBroker.StateChangeHandler): void {
		if (this.statesSubscribes[id]) {
			if (cb) {
				const pos = this.statesSubscribes[id].cbs.indexOf(cb);
				pos !== -1 && this.statesSubscribes[id].cbs.splice(pos, 1);
			} else {
				this.statesSubscribes[id].cbs = [];
			}

			if (
				!this.statesSubscribes[id].cbs ||
				!this.statesSubscribes[id].cbs.length
			) {
				delete this.statesSubscribes[id];
				this.connected && this._socket.emit("unsubscribe", id);
			}
		}
	}

	/**
	 * Subscribe to changes of the given object.
	 * @param id The ioBroker object ID.
	 * @param cb The callback.
	 */
	subscribeObject(
		id: string,
		cb: ioBroker.ObjectChangeHandler,
	): Promise<void> {
		if (!this.objectsSubscribes[id]) {
			let reg = id.replace(/\./g, "\\.").replace(/\*/g, ".*");
			if (!reg.includes("*")) {
				reg += "$";
			}
			this.objectsSubscribes[id] = { reg: new RegExp(reg), cbs: [] };
			this.objectsSubscribes[id].cbs.push(cb);
			this.connected && this._socket.emit("subscribeObjects", id);
		} else {
			!this.objectsSubscribes[id].cbs.includes(cb) &&
				this.objectsSubscribes[id].cbs.push(cb);
		}
		return Promise.resolve();
	}

	/**
	 * Unsubscribes all callbacks from changes of the given object.
	 * @param id The ioBroker object ID.
	 */
	/**
	 * Unsubscribes the given callback from changes of the given object.
	 * @param id The ioBroker object ID.
	 * @param cb The callback.
	 */
	unsubscribeObject(
		id: string,
		cb: ioBroker.ObjectChangeHandler,
	): Promise<void> {
		if (this.objectsSubscribes[id]) {
			if (cb) {
				const pos = this.objectsSubscribes[id].cbs.indexOf(cb);
				pos !== -1 && this.objectsSubscribes[id].cbs.splice(pos, 1);
			} else {
				this.objectsSubscribes[id].cbs = [];
			}

			if (
				this.connected &&
				(!this.objectsSubscribes[id].cbs ||
					!this.objectsSubscribes[id].cbs.length)
			) {
				delete this.objectsSubscribes[id];
				this.connected && this._socket.emit("unsubscribeObjects", id);
			}
		}
		return Promise.resolve();
	}

	/**
	 * Called internally.
	 * @param id
	 * @param obj
	 */
	private objectChange(id: string, obj: ioBroker.Object | null | undefined) {
		// update main.objects cache
		if (!this.objects) {
			return;
		}

		/** @type {import("./types").OldObject} */
		let oldObj: import("./types").OldObject;

		let changed = false;
		if (obj) {
			if (obj._rev && this.objects[id]) {
				this.objects[id]._rev = obj._rev;
			}

			if (this.objects[id]) {
				oldObj = { _id: id, type: this.objects[id].type };
			}

			if (
				!this.objects[id] ||
				JSON.stringify(this.objects[id]) !== JSON.stringify(obj)
			) {
				this.objects[id] = obj;
				changed = true;
			}
		} else if (this.objects[id]) {
			oldObj = { _id: id, type: this.objects[id].type };
			delete this.objects[id];
			changed = true;
		}

		Object.keys(this.objectsSubscribes).forEach((_id) => {
			if (_id === id || this.objectsSubscribes[_id].reg.test(id)) {
				this.objectsSubscribes[_id].cbs.forEach((cb) =>
					cb(id, obj, oldObj),
				);
			}
		});

		if (changed && this.props.onObjectChange) {
			this.props.onObjectChange(id, obj);
		}
	}

	/**
	 * Called internally.
	 * @param id
	 * @param state
	 */
	private stateChange(id: string, state: ioBroker.State | null | undefined) {
		for (const task in this.statesSubscribes) {
			if (
				this.statesSubscribes.hasOwnProperty(task) &&
				this.statesSubscribes[task].reg.test(id)
			) {
				this.statesSubscribes[task].cbs.forEach((cb) => cb(id, state));
			}
		}
	}

	/** Requests data from the server or reads it from the cache */
	protected async request<T>({
		cacheKey,
		forceUpdate,
		commandTimeout,
		onTimeout,
		requireAdmin,
		requireFeatures,
		requestName,
		executor,
	}: RequestOptions<T>): Promise<T> {
		// TODO: mention requestName in errors

		// If the command requires the admin adapter, enforce it
		if (requireAdmin && Connection.isWeb()) {
			return Promise.reject(ERRORS.NOT_ADMIN);
		}

		// Return the cached value if allowed
		if (cacheKey && !forceUpdate && cacheKey in this._promises) {
			return this._promises[cacheKey];
		}

		// Require the socket to be connected
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}

		// Check if all required features are supported
		if (requireFeatures?.length) {
			for (const feature of requireFeatures) {
				if (!(await this.checkFeatureSupported(feature))) {
					throw ERRORS.NOT_SUPPORTED;
				}
			}
		}

		const promise = new Promise<T>(async (resolve, reject) => {
			const timeoutControl = {
				elapsed: false,
				clearTimeout: () => {
					// no-op unless there is a timeout
				},
			};
			let timeout: NodeJS.Timeout | undefined;
			if (commandTimeout !== false) {
				timeout = setTimeout(() => {
					timeoutControl.elapsed = true;
					// Let the caller know that the timeout elapsed
					onTimeout?.();
					reject(ERRORS.TIMEOUT);
				}, commandTimeout ?? this.props.cmdTimeout);
				timeoutControl.clearTimeout = () => {
					clearTimeout(timeout!);
				};
			}
			// Call the actual function - awaiting it allows us to catch sync and async errors
			// no matter if the executor is async or not
			try {
				await executor(resolve, reject, timeoutControl);
			} catch (e) {
				reject(e);
			}
		});
		if (cacheKey) {
			this._promises[cacheKey] = promise;
		}
		return promise;
	}

	/**
	 * Gets all states.
	 * @param disableProgressUpdate don't call onProgress() when done
	 */
	getStates(): // disableProgressUpdate?: boolean,
	Promise<Record<string, ioBroker.State>> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("getStates", (err, res) => {
					this.states = res ?? {};

					// if (!disableProgressUpdate) {
					// 	this.props.onProgress?.(PROGRESS.STATES_LOADED);
					// }
					if (err) reject(err);
					resolve(this.states);
				});
			},
		});
	}

	/**
	 * Gets the given state.
	 * @param id The state ID.
	 */
	getState(id: string): Promise<ioBroker.State | null | undefined> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("getState", id, (err, state) => {
					if (err) reject(err);
					resolve(state);
				});
			},
		});
	}

	/**
	 * Gets the given binary state Base64 encoded.
	 * @param id The state ID.
	 */
	getBinaryState(id: string): Promise<string | undefined> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("getBinaryState", id, (err, state) => {
					if (err) reject(err);
					resolve(state);
				});
			},
		});
	}

	/**
	 * Sets the given binary state.
	 * @param id The state ID.
	 * @param base64 The Base64 encoded binary data.
	 */
	setBinaryState(id: string, base64: string): Promise<void> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("setBinaryState", id, base64, (err) => {
					if (err) reject(err);
					resolve();
				});
			},
		});
	}

	/**
	 * Sets the given state value.
	 * @param id The state ID.
	 * @param val The state value.
	 */
	setState(
		id: string,
		val: ioBroker.State | ioBroker.StateValue | ioBroker.SettableState,
	): Promise<void> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("setState", id, val, (err) => {
					if (err) reject(err);
					resolve();
				});
			},
		});
	}

	/**
	 * Gets all objects.
	 * @param update Callback that is executed when all objects are retrieved.
	 */
	/**
	 * Gets all objects.
	 * @param update Set to true to retrieve all objects from the server (instead of using the local cache).
	 * @param disableProgressUpdate don't call onProgress() when done
	 */
	getObjects(
		update?: boolean,
		disableProgressUpdate?: boolean,
	): Promise<Record<string, ioBroker.Object>> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				if (!update && this.objects) {
					resolve(this.objects);
					return;
				}

				this._socket.emit(
					Connection.isWeb() ? "getObjects" : "getAllObjects",
					(err, res) => {
						this.objects = res;
						if (!disableProgressUpdate)
							this.props.onProgress?.(PROGRESS.OBJECTS_LOADED);
						if (err) reject(err);
						resolve(this.objects);
					},
				);
			},
		});
	}

	/**
	 * Called internally.
	 * @param isEnable
	 */
	private _subscribe(isEnable: boolean) {
		if (isEnable && !this.subscribed) {
			this.subscribed = true;
			this.autoSubscribes.forEach((id) =>
				this._socket.emit("subscribeObjects", id),
			);
			// re subscribe objects
			Object.keys(this.objectsSubscribes).forEach((id) =>
				this._socket.emit("subscribeObjects", id),
			);
			// re-subscribe logs
			this.autoSubscribeLog && this._socket.emit("requireLog", true);
			// re subscribe states
			Object.keys(this.statesSubscribes).forEach((id) =>
				this._socket.emit("subscribe", id),
			);
		} else if (!isEnable && this.subscribed) {
			this.subscribed = false;
			// un-subscribe objects
			this.autoSubscribes.forEach((id) =>
				this._socket.emit("unsubscribeObjects", id),
			);
			Object.keys(this.objectsSubscribes).forEach((id) =>
				this._socket.emit("unsubscribeObjects", id),
			);
			// un-subscribe logs
			this.autoSubscribeLog && this._socket.emit("requireLog", false);

			// un-subscribe states
			Object.keys(this.statesSubscribes).forEach((id) =>
				this._socket.emit("unsubscribe", id),
			);
		}
	}

	/**
	 * Requests log updates.
	 * @param isEnabled Set to true to get logs.
	 */
	requireLog(isEnabled: boolean): Promise<void> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("requireLog", isEnabled, (err) => {
					if (err) reject(err);
					resolve();
				});
			},
		});
	}

	/**
	 * Deletes the given object.
	 * @param id The object ID.
	 * @param maintenance Force deletion of non conform IDs.
	 */
	delObject(id: string, maintenance: boolean = false): Promise<void> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("delObject", id, { maintenance }, (err) => {
					if (err) reject(err);
					resolve();
				});
			},
		});
	}

	/**
	 * Deletes the given object and all its children.
	 * @param id The object ID.
	 * @param maintenance Force deletion of non conform IDs.
	 */
	delObjects(id: string, maintenance: boolean): Promise<void> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("delObjects", id, { maintenance }, (err) => {
					if (err) reject(err);
					resolve();
				});
			},
		});
	}

	/**
	 * Sets the object.
	 * @param id The object ID.
	 * @param obj The object.
	 */
	setObject(id: string, obj: ioBroker.SettableObject): Promise<void> {
		if (!obj) {
			return Promise.reject("Null object is not allowed");
		}

		obj = JSON.parse(JSON.stringify(obj));
		delete obj.from;
		delete obj.user;
		delete obj.ts;

		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("setObject", id, obj, (err) => {
					if (err) reject(err);
					resolve();
				});
			},
		});
	}

	/**
	 * Gets the object with the given id from the server.
	 * @param id The object ID.
	 * @returns {ioBroker.GetObjectPromise} The object.
	 */
	getObject<T extends string>(id: T): ioBroker.GetObjectPromise<T> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("getObject", id, (err, obj) => {
					if (err) reject(err);
					resolve(obj as any);
				});
			},
		});
	}

	/**
	 * Sends a message to a specific instance or all instances of some specific adapter.
	 * @param instance The instance to send this message to.
	 * @param command Command name of the target instance.
	 * @param data The message data to send.
	 */
	sendTo(
		instance: string,
		command: string,
		data: ioBroker.MessagePayload,
	): Promise<ioBroker.Message | undefined> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve) => {
				this._socket.emit(
					"sendTo",
					instance,
					command,
					data,
					(result) => {
						resolve(result);
					},
				);
			},
		});
	}

	/**
	 * Extend an object and create it if it might not exist.
	 * @param id The id.
	 * @param obj The object.
	 */
	extendObject(id: string, obj: ioBroker.PartialObject): Promise<void> {
		if (!obj) {
			return Promise.reject("Null object is not allowed");
		}

		obj = JSON.parse(JSON.stringify(obj));
		delete obj.from;
		delete obj.user;
		delete obj.ts;

		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("extendObject", id, obj, (err) => {
					if (err) reject(err);
					resolve();
				});
			},
		});
	}

	/**
	 * Register a handler for log messages.
	 * @param handler The handler.
	 */
	registerLogHandler(handler: (message: string) => void): void {
		if (!this.onLogHandlers.includes(handler)) {
			this.onLogHandlers.push(handler);
		}
	}

	/**
	 * Unregister a handler for log messages.
	 * @param handler The handler.
	 */
	unregisterLogHandler(handler: (message: string) => void): void {
		const pos = this.onLogHandlers.indexOf(handler);
		pos !== -1 && this.onLogHandlers.splice(pos, 1);
	}

	/**
	 * Register a handler for the connection state.
	 * @param handler The handler.
	 */
	registerConnectionHandler(handler: (connected: boolean) => void): void {
		if (!this.onConnectionHandlers.includes(handler)) {
			this.onConnectionHandlers.push(handler);
		}
	}

	/**
	 * Unregister a handler for the connection state.
	 * @param handler The handler.
	 */
	unregisterConnectionHandler(handler: (connected: boolean) => void): void {
		const pos = this.onConnectionHandlers.indexOf(handler);
		pos !== -1 && this.onConnectionHandlers.splice(pos, 1);
	}

	/**
	 * Set the handler for standard output of a command.
	 * @param handler The handler.
	 */
	registerCmdStdoutHandler(
		handler: (id: string, text: string) => void,
	): void {
		this.onCmdStdoutHandler = handler;
	}

	/**
	 * Unset the handler for standard output of a command.
	 */
	unregisterCmdStdoutHandler(): void {
		this.onCmdStdoutHandler = undefined;
	}

	/**
	 * Set the handler for standard error of a command.
	 * @param handler The handler.
	 */
	registerCmdStderrHandler(
		handler: (id: string, text: string) => void,
	): void {
		this.onCmdStderrHandler = handler;
	}

	/**
	 * Unset the handler for standard error of a command.
	 */
	unregisterCmdStderrHandler(): void {
		this.onCmdStderrHandler = undefined;
	}

	/**
	 * Set the handler for exit of a command.
	 * @param handler The handler.
	 */
	registerCmdExitHandler(
		handler: (id: string, exitCode: number) => void,
	): void {
		this.onCmdExitHandler = handler;
	}

	/**
	 * Unset the handler for exit of a command.
	 */
	unregisterCmdExitHandler(): void {
		this.onCmdExitHandler = undefined;
	}

	/**
	 * Get all enums with the given name.
	 * @param _enum The name of the enum
	 * @param update Force update.
	 */
	getEnums(
		_enum?: string,
		update?: boolean,
	): Promise<Record<string, ioBroker.EnumObject>> {
		return this.request({
			cacheKey: `enums_${_enum || "all"}`,
			forceUpdate: update,
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit(
					"getObjectView",
					"system",
					"enum",
					{
						startkey: `enum.${_enum || ""}`,
						endkey: _enum ? `enum.${_enum}.\u9999` : `enum.\u9999`,
					},
					(err, res) => {
						if (err) reject(err);
						const _res: Record<string, ioBroker.EnumObject> = {};
						if (res) {
							for (let i = 0; i < res.rows.length; i++) {
								if (
									_enum &&
									res.rows[i].id === `enum.${_enum}`
								) {
									continue;
								}
								_res[res.rows[i].id] = res.rows[i]
									.value as ioBroker.EnumObject;
							}
						}
						resolve(_res);
					},
				);
			},
		});
	}

	/**
	 * Query a predefined object view.
	 * @param start The start ID.
	 * @param end The end ID.
	 * @param type The type of object.
	 */
	getObjectView<T extends ioBroker.ObjectType>(
		start: string,
		end: string,
		type: T,
	): Promise<Record<string, ioBroker.AnyObject & { type: T }>> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				start = start || "";
				end = end || "\u9999";

				this._socket.emit(
					"getObjectView",
					"system",
					type,
					{ startkey: start, endkey: end },
					(err, res) => {
						if (err) reject(err);

						const _res: Record<
							string,
							ioBroker.AnyObject & { type: T }
						> = {};
						if (res && res.rows) {
							for (let i = 0; i < res.rows.length; i++) {
								_res[res.rows[i].id] = res.rows[i].value as any;
							}
						}
						resolve(_res);
					},
				);
			},
		});
	}

	/**
	 * Read the meta items.
	 */
	readMetaItems(): Promise<ioBroker.Object[]> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit(
					"getObjectView",
					"system",
					"meta",
					{ startkey: "", endkey: "\u9999" },
					(err, objs) => {
						if (err) reject(err);
						resolve(
							objs!.rows
								?.map((obj) => obj.value)
								.filter((val): val is ioBroker.Object => !!val),
						);
					},
				);
			},
		});
	}

	/**
	 * Read the directory of an adapter.
	 * @param adapterName The adapter name.
	 * @param path The directory name.
	 */
	readDir(
		adapterName: string | null,
		path: string,
	): Promise<ioBroker.ReadDirResult[]> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit(
					"readDir",
					adapterName,
					path,
					(err, files) => {
						if (err) reject(err);
						resolve(files!);
					},
				);
			},
		});
	}

	readFile(
		adapterName: string | null,
		fileName: string,
		base64?: boolean,
	): Promise<{ file: string; mimeType: string }> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit(
					base64 ? "readFile64" : "readFile",
					adapterName,
					fileName,
					(err, data, type) => {
						if (err) reject(err);
						resolve({ file: data as string, mimeType: type! });
					},
				);
			},
		});
	}

	/**
	 * Write a file of an adapter.
	 * @param adapter The adapter name.
	 * @param fileName The file name.
	 * @param data The data (if it's a Buffer, it will be converted to Base64).
	 */
	writeFile64(
		adapter: string,
		fileName: string,
		data: Buffer | string,
	): Promise<void> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				if (typeof data === "string") {
					this._socket.emit(
						"writeFile",
						adapter,
						fileName,
						data,
						(err) => {
							if (err) reject(err);
							resolve();
						},
					);
				} else {
					const base64 = btoa(
						new Uint8Array(data).reduce(
							(data, byte) => data + String.fromCharCode(byte),
							"",
						),
					);

					this._socket.emit(
						"writeFile64",
						adapter,
						fileName,
						base64,
						(err) => {
							if (err) reject(err);
							resolve();
						},
					);
				}
			},
		});
	}

	/**
	 * Delete a file of an adapter.
	 * @param adapter The adapter name.
	 * @param fileName The file name.
	 */
	deleteFile(adapter: string, fileName: string): Promise<void> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("deleteFile", adapter, fileName, (err) => {
					if (err) reject(err);
					resolve();
				});
			},
		});
	}

	/**
	 * Delete a folder of an adapter.
	 * @param adapter The adapter name.
	 * @param folderName The folder name.
	 */
	deleteFolder(adapter: string, folderName: string): Promise<void> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit(
					"deleteFolder",
					adapter,
					folderName,
					(err) => {
						if (err) reject(err);
						resolve();
					},
				);
			},
		});
	}

	/**
	 * Execute a command on a host.
	 * @param host The host name.
	 * @param cmd The command.
	 * @param cmdId The command ID.
	 * @param cmdTimeout Timeout of command in ms
	 */
	cmdExec(
		host: string,
		cmd: string,
		cmdId: string,
		cmdTimeout?: number,
	): Promise<void> {
		return this.request({
			commandTimeout: cmdTimeout,
			executor: (resolve, reject, timeout) => {
				host = normalizeHostId(host);

				this._socket.emit("cmdExec", host, cmdId, cmd, (err) => {
					if (timeout.elapsed) return;
					timeout.clearTimeout();

					if (err) reject(err);
					resolve();
				});
			},
		});
	}

	/**
	 * Gets the system configuration.
	 * @param update Force update.
	 */
	getSystemConfig(
		update?: boolean,
	): ioBroker.GetObjectPromise<"system.config"> {
		return this.request({
			cacheKey: "systemConfig",
			forceUpdate: update,
			// TODO: check if this should time out
			commandTimeout: false,
			executor: async (resolve) => {
				let systemConfig = await this.getObject("system.config");
				(systemConfig as any) ??= {};
				(systemConfig as any).common ??= {};
				(systemConfig as any).native ??= {};

				resolve(systemConfig!);
			},
		});
	}

	// returns very optimized information for adapters to minimize connection load
	getCompactSystemConfig(
		update?: boolean,
	): Promise<ioBroker.ObjectIdToObjectType<"system.config">> {
		return this.request({
			cacheKey: "systemConfigCommon",
			forceUpdate: update,
			// TODO: check if this should time out
			commandTimeout: false,
			requireAdmin: true,
			executor: (resolve, reject) => {
				this._socket.emit(
					"getCompactSystemConfig",
					(err, systemConfig) => {
						if (err) reject(err);
						resolve(systemConfig!);
					},
				);
			},
		});
	}

	/**
	 * Read all states (which might not belong to this adapter) which match the given pattern.
	 * @param pattern
	 */
	getForeignStates(
		pattern?: string | null | undefined,
	): ioBroker.GetStatesPromise {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit(
					"getForeignStates",
					pattern || "*",
					(err, states) => {
						if (err) reject(err);
						resolve(states);
					},
				);
			},
		});
	}

	/**
	 * Get foreign objects by pattern, by specific type and resolve their enums.
	 * @param pattern
	 * @param type
	 */
	getForeignObjects<T extends ioBroker.ObjectType>(
		pattern: string | null | undefined,
		type: T,
	): Promise<Record<string, ioBroker.AnyObject & { type: T }>> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit(
					"getForeignObjects",
					pattern || "*",
					type,
					(err, objects) => {
						if (err) reject(err);
						resolve(objects as any);
					},
				);
			},
		});
	}

	/**
	 * Sets the system configuration.
	 * @param obj
	 */
	setSystemConfig(
		obj: ioBroker.SettableObjectWorker<ioBroker.OtherObject>,
	): Promise<ioBroker.SettableObjectWorker<ioBroker.OtherObject>> {
		return this.request({
			cacheKey: "systemConfig",
			// TODO: check if this should time out
			commandTimeout: false,
			executor: async (resolve) => {
				await this.setObject("system.config", obj);
				resolve(obj);
			},
		});
	}

	/**
	 * Get the raw socket.io socket.
	 */
	getRawSocket(): any {
		return this._socket;
	}

	/**
	 * Get the history of a given state.
	 * @param id
	 * @param options
	 */
	getHistory(
		id: string,
		options: ioBroker.GetHistoryOptions,
	): Promise<ioBroker.GetHistoryResult> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("getHistory", id, options, (err, values) => {
					if (err) reject(err);
					resolve(values!);
				});
			},
		});
	}

	/**
	 * Get the history of a given state.
	 * @param id
	 * @param options
	 */
	getHistoryEx(
		id: string,
		options: ioBroker.GetHistoryOptions,
	): Promise<{
		values: ioBroker.GetHistoryResult;
		sessionId: string;
		stepIgnore: number;
	}> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit(
					"getHistory",
					id,
					options,
					(err, values, stepIgnore, sessionId) => {
						if (err) reject(err);
						resolve({
							values: values!,
							sessionId: sessionId!,
							// TODO: WTF is up with the ignore thing?
							stepIgnore: stepIgnore!,
						});
					},
				);
			},
		});
	}

	/**
	 * Get the IP addresses of the given host.
	 * @param host
	 * @param update Force update.
	 */
	getIpAddresses(host: string, update?: boolean): Promise<string[]> {
		host = normalizeHostId(host);
		return this.request({
			cacheKey: `IPs_${host}`,
			forceUpdate: update,
			// TODO: check if this should time out
			commandTimeout: false,
			executor: async (resolve) => {
				const obj = await this.getObject(host);
				resolve(obj?.common.address ?? []);
			},
		});
	}

	/**
	 * Gets the version.
	 */
	getVersion(): Promise<{ version: string; serverName: string }> {
		return this.request({
			cacheKey: "version",
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("getVersion", (err, version, serverName) => {
					// Old socket.io had no error parameter
					if (
						err &&
						!version &&
						typeof err === "string" &&
						err.match(/\d+\.\d+\.\d+/)
					) {
						resolve({ version: err, serverName: "socketio" });
					} else {
						if (err) reject(err);
						resolve({ version: version!, serverName: serverName! });
					}
				});
			},
		});
	}

	/**
	 * Gets the web server name.
	 */
	getWebServerName(): Promise<string> {
		return this.request({
			cacheKey: "webName",
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("getAdapterName", (err, name) => {
					if (err) reject(err);
					resolve(name!);
				});
			},
		});
	}

	/**
	 * Check if the file exists
	 * @param adapter adapter name
	 * @param filename file name with full path. it could be like vis.0/*
	 */
	fileExists(adapter: string, filename: string): Promise<boolean> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit(
					"fileExists",
					adapter,
					filename,
					(err, exists) => {
						if (err) reject(err);
						resolve(!!exists);
					},
				);
			},
		});
	}

	/**
	 * Read current user
	 */
	getCurrentUser(): Promise<string> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve) => {
				this._socket.emit("authEnabled", (_isSecure, user) => {
					resolve(user);
				});
			},
		});
	}

	/**
	 * Get uuid
	 */
	getUuid(): Promise<ioBroker.Object[]> {
		return this.request({
			cacheKey: "uuid",
			// TODO: check if this should time out
			commandTimeout: false,
			executor: async (resolve) => {
				const obj = await this.getObject("system.meta.uuid");
				resolve(obj?.native?.uuid);
			},
		});
	}

	/**
	 * Checks if a given feature is supported.
	 * @param feature The feature to check.
	 * @param update Force update.
	 */
	checkFeatureSupported(feature: string, update?: boolean): Promise<any> {
		return this.request({
			cacheKey: `supportedFeatures_${feature}`,
			forceUpdate: update,
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit(
					"checkFeatureSupported",
					feature,
					(err, features) => {
						if (err) reject(err);
						resolve(features);
					},
				);
			},
		});
	}

	/**
	 * Get all adapter instances.
	 * @param update Force update.
	 */
	/**
	 * Get all instances of the given adapter.
	 * @param adapter The name of the adapter.
	 * @param update Force update.
	 */
	getAdapterInstances(
		adapter?: string,
		update?: boolean,
	): Promise<ioBroker.InstanceObject[]> {
		if (typeof adapter === "boolean") {
			update = adapter;
			adapter = "";
		}
		adapter = adapter || "";

		return this.request({
			cacheKey: `instances_${adapter}`,
			forceUpdate: update,
			// TODO: check if this should time out
			commandTimeout: false,
			executor: async (resolve) => {
				const startKey = adapter
					? `system.adapter.${adapter}.`
					: "system.adapter.";
				const endKey = `${startKey}\u9999`;

				const instances = await this.getObjectView(
					startKey,
					endKey,
					"instance",
				);
				const instanceObjects = Object.values(instances);
				if (adapter) {
					resolve(
						instanceObjects.filter(
							(o) => o.common.name === adapter,
						),
					);
				} else {
					resolve(instanceObjects);
				}
			},
		});
	}

	/**
	 * Get adapters with the given name.
	 * @param adapter The name of the adapter.
	 * @param update Force update.
	 */
	getAdapters(
		adapter?: string,
		update?: boolean,
	): Promise<ioBroker.AdapterObject[]> {
		if (typeof adapter === "boolean") {
			update = adapter;
			adapter = "";
		}
		adapter = adapter || "";

		return this.request({
			cacheKey: `adapter_${adapter}`,
			forceUpdate: update,
			// TODO: check if this should time out
			commandTimeout: false,
			executor: async (resolve) => {
				const adapters = await this.getObjectView(
					`system.adapter.${adapter || ""}`,
					`system.adapter.${adapter || "\u9999"}`,
					"adapter",
				);
				const adapterObjects = Object.values(adapters);
				if (adapter) {
					resolve(
						adapterObjects.filter((o) => o.common.name === adapter),
					);
				} else {
					resolve(adapterObjects);
				}
			},
		});
	}
}
