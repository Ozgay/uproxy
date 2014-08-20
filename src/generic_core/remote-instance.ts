/**
 * remote-instance.ts
 *
 * This file defines the uProxy Instance class for remote installations. It
 * allows any pair of uProxy installations to speak to one another regarding
 * consent, proxying status, and any other signalling information.
 */
/// <reference path='../interfaces/instance.d.ts' />
/// <reference path='../interfaces/persistent.d.ts' />
/// <reference path='consent.ts' />
/// <reference path='social.ts' />
/// <reference path='util.ts' />

// declare var storage :Core.Storage;

module Core {

  /**
   * RemoteInstance - represents a remote uProxy installation.
   *
   * These remote instances are semi-permanent, and belong only to one user.
   * They can be online or offline depending on if they are associated with a
   * client. Interface-wise, this class is only aware of its parent User, and
   * does not have any direct interaction with the network it belongs to.
   *
   * There are two pathways to modifying the consent of this remote instance.
   * - Locally, via a user command from the UI.
   * - Remotely, via consent bits sent over the wire by a friend.
   */
  export class RemoteInstance implements Instance, Core.Persistent {

    public instanceId  :string;
    public keyHash     :string
    public description :string;

    public consent     :ConsentState = {
      asClient: Consent.ClientState.NONE,
      asProxy:  Consent.ProxyState.NONE
    };
    // Current proxy access activity of the remote instance with respect to the
    // local instance of uProxy.
    public access      :AccessState = {
      asClient: false,
      asProxy:  false
    };
    public updateDate = null;
    private transport  :Transport;

    // Functions to fulfill or reject the promise returned by start method.
    // These will only be set while waiting for socks-to-rtc to setup
    // peer-to-peer connection, otherwise they will be null.
    private fulfillStartRequest_ = null;
    private rejectStartRequest_ = null;

    /**
     * Construct a Remote Instance as the result of receiving an instance
     * handshake, or loadig from storage. Typically, instances are initialized
     * with the lowest consent values.
     */
    constructor(
        public user :Core.User,  // The User which this instance belongs to.
        instanceData        :Instance) {
      this.update(<InstanceHandshake>instanceData);
      // Load consent state if it exists. Don't load access state.
      if (instanceData.consent) {
        this.consent = instanceData.consent;
      }
    }

    /**
     * Obtain the prefix for all storage keys associated with this Instance.
     * Since the parent User's userId may change, only store the userId.
     */
    public getStorePath = () => {
      return this.user.getStorePath() + '/' + this.instanceId;
    }

    /**
     * Send a message to this instance. Queues messages if the instance is
     * currently not reachable. (Its client went offline, and a new one may show
     * up in the future)
     *
     * TODO: Implement queueing using promises.
     * First we need to know that the social API's sendMessage propogates error
     * messages.
     */
    public send = (msg:uProxy.Message) => {
      // The parent User is responsible for mapping the instanceId to the
      // correct clientId so that the social network can pass the message along.
      this.user.send(this.instanceId, msg);
    }

    /**
     * Handle signals sent along the signalling channel from the remote
     * instance, and pass it along to the relevant socks-rtc module.
     * TODO: spec
     * TODO: assuming that signal is valid, should we remove signal?
     */
    public handleSignal = (type:uProxy.MessageType, signalFromWire:PeerSignal) => {
      // We are ignoring the peerId from signalFromWire for now.
      // We need to construct a LocalPeerId object (containing both the client and server
      // instanceIds, userIds, and networks) for communication with socks-rtc
      var isLocalServer :boolean = (type == uProxy.MessageType.SIGNAL_FROM_CLIENT_PEER);
      var localPeerId :LocalPeerId = this.getLocalPeerId(isLocalServer);
      var signalForSocksRtc :PeerSignal = {
        peerId: JSON.stringify(localPeerId),
        data: signalFromWire.data
      };

      switch (type) {
        case uProxy.MessageType.SIGNAL_FROM_CLIENT_PEER:
          // If the remote peer sent signal as the client, we act as server.
          rtcToNetServer.emit('handleSignalFromPeer', signalForSocksRtc);
          break;
        case uProxy.MessageType.SIGNAL_FROM_SERVER_PEER:
          // If the remote peer sent signal as the server, we act as client.
          socksToRtcClient.emit('handleSignalFromPeer', signalForSocksRtc);
          break;
        default:
          console.warn('Invalid signal! ' + uProxy.MessageType[type]);
          return
      }
    }

    /**
     * Begin to use this remote instance as a proxy server, if permission is
     * currently granted.
     */
    public start = () : Promise<void> => {
      if (Consent.ProxyState.GRANTED !== this.consent.asProxy) {
        console.warn('Lacking permission to proxy!');
        return Promise.reject();
      } else if (this.access.asProxy) {
        // This should not happen. If it does, something else is broken. Still, we
        // continue to actually proxy through the instance.
        console.warn('Already proxying through ' + this.instanceId);
        return Promise.reject();
      } else if (this.fulfillStartRequest_ || this.rejectStartRequest_) {
        console.warn('Already waiting for proxy to start ' + this.instanceId);
        return Promise.reject();
      }
      // TODO: sync properly between the extension and the app on proxy settings
      // rather than this cooincidentally the same data.
      // TODO: Convert socks-rtc's message types to Enums.

      // Speak with socks-rtc to start the connection.
      // The localhost host:port will be taken care of by WebRTC. The peerId is
      // utilized to set the local and remote descriptions on the
      // RTCPeerConnection.

      // PeerId sent to socks-rtc libraries should be LocalPeerId that includes
      // instanceId, userId, and network fields.
      // The "false" parameter to getLocalPeerId means the local instance is
      // the client, not server.
      var localPeerId :LocalPeerId = this.getLocalPeerId(false);
      console.log('starting client with localPeerId: ' + JSON.stringify(localPeerId));
      socksToRtcClient.emit('start', {
          'host': '127.0.0.1', 'port': 9999,
           // Peer's peerId is the same as our InstancePath
           // TODO: make network public or change api.
          'peerId': JSON.stringify(localPeerId)
      });
      return new Promise<void>((F, R) => {
        // Save fulfill and reject functions, to be invoked after
        // a signal is received back from socksToRtcClient.
        this.fulfillStartRequest_ = F;
        this.rejectStartRequest_ = R;
      }).then(() => {
        console.log('Proxy now ready through ' + this.user.userId);
        this.fulfillStartRequest_ = null;
        this.rejectStartRequest_ = null;
        this.access.asProxy = true;
        this.user.notifyUI();
      }).catch(() => {
        console.error('Could not start proxy through ' + this.user.userId);
        this.fulfillStartRequest_ = null;
        this.rejectStartRequest_ = null;
        return Promise.reject();
      });
    }

    public handleStartSuccess = () => {
      if (!this.fulfillStartRequest_) {
        console.error('No fulfillStartRequest_ for handleStartSuccess');
        return;
      }
      this.fulfillStartRequest_();
    }

    public handleStartFailure = () => {
      if (!this.rejectStartRequest_) {
        console.error('No rejectStartRequest_ for handleStartSuccess');
        return;
      }
      this.rejectStartRequest_();
    }

    public updateClientProxyConnection = (isConnected :boolean) => {
      this.access.asClient = isConnected;
      this.user.notifyUI();
    }

    /**
     * Stop using this remote instance as a proxy server.
     */
    public stop = () : void => {
      if (!this.access.asProxy) {
        console.warn('Cannot stop proxying when not proxying.');
        return;
      }
      socksToRtcClient.emit('stop');
      this.access.asProxy = false;
      this.user.notifyUI();
    }

    /**
     * Update the information about this remote instance as a result of its
     * Instance Message.
     * Assumes that |data| actually belongs to this instance.
     */
    public update = (data :InstanceHandshake) => {
      this.instanceId = data.instanceId;
      this.keyHash = data.keyHash;
      this.description = data.description;
      this.user.notifyUI();
      this.saveToStorage();
      this.updateDate = new Date();
    }

    /**
     * Modify the consent for this instance, *locally*. (User clicked on one of
     * the consent buttons in the UI.) Sends updated consent bits to the
     * remote instance afterwards.
     *
     * Gives a warning for UserActions which are invalid for the current state.
     */
    public modifyConsent = (action :Consent.UserAction) => {
      switch(action) {
        // Actions affecting our consent towards the remote as our proxy.
        case Consent.UserAction.REQUEST:
        case Consent.UserAction.CANCEL_REQUEST:
        case Consent.UserAction.ACCEPT_OFFER:
        case Consent.UserAction.IGNORE_OFFER:
          var newProxyConsent = Consent.userActionOnProxyState(
              action, this.consent.asProxy);
          if (newProxyConsent) {
            this.consent.asProxy = newProxyConsent;
          } else {
            console.warn('Invalid proxy consent transition!',
                this.consent.asProxy, action);
            return;
          }
          break;
        // Actions affecting our consent towards the remote as our client.
        case Consent.UserAction.OFFER:
        case Consent.UserAction.CANCEL_OFFER:
        case Consent.UserAction.ALLOW_REQUEST:
        case Consent.UserAction.IGNORE_REQUEST:
          var newClientConsent = Consent.userActionOnClientState(
              action, this.consent.asClient);
          if (newClientConsent) {
            this.consent.asClient = newClientConsent;
          } else {
            console.warn('Invalid client consent transition!',
                this.consent.asClient, action);
            return;
          }
          break;
        default:
          console.warn('Invalid Consent.UserAction! ' + action);
          return;
      }
      // If remote is currently an active client, but user revokes access, also
      // stop the proxy session.
      if (Consent.UserAction.CANCEL_OFFER == action && this.access.asClient) {
        // TODO: emit a signal to rtcToNet to stop our peer, once that
        // functionality is implemented in the socks-rtc repo.
      }
      // Send new consent bits to the remote client, and save to storage.
      this.sendConsent();
      this.saveToStorage();
      // Send an update to the UI.
      this.user.notifyUI();
    }

    /**
     * Send consent bits to re-synchronize consent with remote |instance|.
     * This is expected *after* receiving an instance notification for an
     * already existing instance.
     */
    public sendConsent = () => {
      var consentPayload :uProxy.Message = {
        type: uProxy.MessageType.CONSENT,
        data: <ConsentMessage>{
          instanceId: this.user.getLocalInstanceId(),
          consent: this.getConsentBits()
        }
      };
      this.send(consentPayload);
    }

    /**
     * Receive consent bits from the remote, and update consent values
     * accordingly.
     */
    public receiveConsent = (bits:Consent.State) => {
      var oldProxyConsent = this.consent.asProxy;
      var oldClientConsent = this.consent.asClient;
      this.consent.asProxy = Consent.updateProxyStateFromRemoteState(
          bits, this.consent.asProxy);
      this.consent.asClient = Consent.updateClientStateFromRemoteState(
          bits, this.consent.asClient);
      this.saveToStorage();
      // TODO: Make the UI update granular for just the consent, instead of the
      // entire parent User for this instance.
      this.user.notifyUI();
      // Fire a notification on the UI, if a state is different.
      // TODO: Determine if we should attach the instance id / decription to the
      // user name as part of the notification text.
      if (oldProxyConsent != this.consent.asProxy) {
        switch (this.consent.asProxy) {
          case Consent.ProxyState.REMOTE_OFFERED:
            ui.showNotification(this.user.name + ' offered you access.');
            break;
          case Consent.ProxyState.GRANTED:
            ui.showNotification(this.user.name + ' granted you access.');
            break;
          case Consent.ProxyState.USER_REQUESTED:
            // The only way to land in USER_REQUESTED upon reciving consent bits
            // is if the remote has revoked access after previously being in
            // GRANTED.
            if (this.access.asProxy) {
              // If currently proxying through this instance, then stop proxying
              // since there is no longer access. Other than a socksToRtc
              // timeout, this is the only other situation where proxying is
              // interrupted remotely.
              ui.showNotification(this.user.name + ' revoked your access, ' +
                  'which ends your current proxy session.');
              core.stop();
              ui.stopProxyingInUiAndConfig();
            } else {
              ui.showNotification(this.user.name + ' revoked your access.');
            }
            break;
          default:
            // Don't display notification for ignoring, and any other states.
            break;
        }
      }
      if (oldClientConsent != this.consent.asClient) {
        switch (this.consent.asClient) {
          case Consent.ClientState.REMOTE_REQUESTED:
            ui.showNotification(this.user.name + ' is requesting access.');
            break;
          case Consent.ClientState.GRANTED:
            ui.showNotification(this.user.name + ' has accepted your offer of access.');
            break;
          default:
            // Don't display notification for ignoring, and any other states.
            break;
        }
      }
    }

    /**
     * Return the pair of boolean consent bits indicating client and proxy
     * consent status, from the user's point of view. These bits will be sent on
     * thewire.
     */
    public getConsentBits = () : Consent.State => {
      return {
        isRequesting: Consent.ProxyState.userIsRequesting(this.consent.asProxy),
        isOffering: Consent.ClientState.userIsOffering(this.consent.asClient)
      };
    }

    private saveToStorage = () => {
      var state = this.currentState();
      storage.save<RemoteInstanceState>(this.getStorePath(), state)
          .then((old) => {
        console.log('Saved instance ' + this.instanceId + ' to storage.');
      });
    }

    /**
     * Get the raw attributes of the instance to be sent over to the UI or saved
     * to storage.
     */
    public currentState = () : RemoteInstanceState => {
      return cloneDeep({
        instanceId:  this.instanceId,
        description: this.description,
        keyHash:     this.keyHash,
        consent:     this.consent,
        access:      this.access
      });
    }
    public restoreState = (state :RemoteInstanceState) => {
      this.instanceId = state.instanceId,
      this.description = state.description,
      this.keyHash = state.keyHash,
      this.consent = state.consent,
      this.access = state.access
    }

    /**
     * Returns a snapshot of a RemoteInstance's state for the UI. This includes
     * fields like isCurrentProxyClient that we don't want to save to storage.
     */
    public currentStateForUi = () : UI.Instance => {
      return cloneDeep({
        instanceId:           this.instanceId,
        description:          this.description,
        keyHash:              this.keyHash,
        consent:              this.consent,
        access:               this.access,
        isOnline:             this.user.isInstanceOnline(this.instanceId)
      });
    }

    public getLocalPeerId = (isLocalServer :boolean)
        : LocalPeerId => {
      // Construct local and remote instance paths.
      var network :Social.Network = this.user.network;
      var localInstancePath :InstancePath = {
        network: network.name,
        userId: network.myInstance.userId,
        instanceId: network.myInstance.instanceId
      }
      var remoteInstancePath :InstancePath = {
        network: network.name,
        userId: this.user.userId,
        instanceId: this.instanceId
      }

      if (isLocalServer) {
        // Local instance is the server, remote instance is the client.
        return {
          clientInstancePath: remoteInstancePath,
          serverInstancePath: localInstancePath
        };
      } else {
        // Local instance is the client, remote instance is the server.
        return {
          clientInstancePath: localInstancePath,
          serverInstancePath: remoteInstancePath
        };
      }
    }

  }  // class Core.RemoteInstance

  export interface RemoteInstanceState extends Instance {
    keyHash     :string;
    consent     :ConsentState;
    access      :AccessState;
    description ?:string;
  }

  // TODO: Implement obfuscation.
  export enum ObfuscationType {NONE, RANDOM1 }

}  // module Core
