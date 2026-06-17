const WebSocket = require('ws');

class WebSocketServer {
  constructor(port, channelManager, ffmpegAvailable = false, mixerManager = null) {
    this.port = port;
    this.channelManager = channelManager;
    this.ffmpegAvailable = ffmpegAvailable;
    this.mixerManager = mixerManager;
    this.wss = null;
    this.clients = new Map();
  }

  start() {
    this.wss = new WebSocket.Server({ port: this.port });

    this.wss.on('connection', (ws) => {
      let clientChannel = null;
      let clientMixer = null;

      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message);

          switch (data.action) {
            case 'join':
              clientChannel = data.channelId;
              ws._channelId = clientChannel;
              this.sendChannelStatus(ws, clientChannel);
              break;

            case 'joinMixer':
              clientMixer = data.mixerId;
              ws._mixerId = clientMixer;
              this.sendMixerStatus(ws, clientMixer);
              break;

            case 'leave':
              clientChannel = null;
              ws._channelId = null;
              break;

            case 'leaveMixer':
              clientMixer = null;
              ws._mixerId = null;
              break;

            case 'control':
              this.handleControl(ws, data);
              break;

            case 'mixerControl':
              this.handleMixerControl(ws, data);
              break;

            case 'getStatus':
              this.sendChannelStatus(ws, data.channelId || clientChannel);
              break;

            case 'getMixerStatus':
              this.sendMixerStatus(ws, data.mixerId || clientMixer);
              break;
          }
        } catch (e) {
          console.error('WebSocket message error:', e);
        }
      });

      ws.on('close', () => {
      });
    });

    this.channelManager.on('play', (channelId, track) => {
      this.broadcastToChannel(channelId, {
        type: 'trackChange',
        channelId,
        track: { title: track.title, filename: track.filename },
        isPlaying: true
      });
    });

    this.channelManager.on('pause', (channelId) => {
      this.broadcastToChannel(channelId, {
        type: 'statusChange',
        channelId,
        isPlaying: false
      });
    });

    this.channelManager.on('resume', (channelId) => {
      this.broadcastToChannel(channelId, {
        type: 'statusChange',
        channelId,
        isPlaying: true
      });
    });

    this.channelManager.on('volume', (channelId, volume) => {
      this.broadcastToChannel(channelId, {
        type: 'volumeChange',
        channelId,
        volume
      });
    });

    this.channelManager.on('listeners', (channelId, listeners) => {
      this.broadcastToChannel(channelId, {
        type: 'listenersChange',
        channelId,
        listeners
      });
    });

    if (this.mixerManager) {
      this.mixerManager.on('mixerState', (mixerId, state) => {
        this.broadcastToMixer(mixerId, {
          type: 'mixerState',
          mixerId,
          state
        });
      });

      this.mixerManager.on('levelsUpdate', (mixerId, levels) => {
        this.broadcastToMixer(mixerId, {
          type: 'levelsUpdate',
          mixerId,
          levels
        });
      });

      this.mixerManager.on('listeners', (mixerId, listeners) => {
        this.broadcastToMixer(mixerId, {
          type: 'listenersChange',
          mixerId,
          listeners
        });
      });

      this.mixerManager.on('mixerCreated', (mixerId, state) => {
        this.broadcastAll({
          type: 'mixerCreated',
          mixerId,
          state
        });
      });

      this.mixerManager.on('mixerDeleted', (mixerId) => {
        this.broadcastAll({
          type: 'mixerDeleted',
          mixerId
        });
      });
    }

    console.log(`WebSocket server running on port ${this.port}`);
  }

  handleControl(ws, data) {
    const { channelId, command, params } = data;

    switch (command) {
      case 'play':
        this.channelManager.play(channelId, params?.index);
        break;
      case 'pause':
        this.channelManager.pause(channelId);
        break;
      case 'resume':
        this.channelManager.resume(channelId);
        break;
      case 'next':
        this.channelManager.next(channelId);
        break;
      case 'prev':
        this.channelManager.prev(channelId);
        break;
      case 'volume':
        this.channelManager.setVolume(channelId, params?.volume);
        break;
    }
  }

  handleMixerControl(ws, data) {
    if (!this.mixerManager) return;
    const { mixerId, command, params } = data;

    switch (command) {
      case 'start':
        this.mixerManager.startMixing(mixerId);
        break;
      case 'stop':
        this.mixerManager.stopMixing(mixerId);
        break;
      case 'masterVolume':
        this.mixerManager.setMasterVolume(mixerId, params?.volume);
        break;
      case 'inputVolume':
        this.mixerManager.setInputVolume(mixerId, params?.channelId, params?.volume);
        break;
      case 'inputPan':
        this.mixerManager.setInputPan(mixerId, params?.channelId, params?.pan);
        break;
      case 'inputMute':
        this.mixerManager.setInputMuted(mixerId, params?.channelId, params?.muted);
        break;
      case 'inputEnable':
        this.mixerManager.setInputEnabled(mixerId, params?.channelId, params?.enabled);
        break;
      case 'startRecord':
        this.mixerManager.startRecording(mixerId);
        break;
      case 'stopRecord':
        this.mixerManager.stopRecording(mixerId);
        break;
    }
  }

  broadcastToChannel(channelId, message) {
    const data = JSON.stringify(message);
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && client._channelId === channelId) {
        client.send(data);
      }
    });
  }

  broadcastToMixer(mixerId, message) {
    const data = JSON.stringify(message);
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && client._mixerId === mixerId) {
        client.send(data);
      }
    });
  }

  broadcastAll(message) {
    const data = JSON.stringify(message);
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }

  sendChannelStatus(ws, channelId) {
    const channel = this.channelManager.getChannel(channelId);
    if (!channel) return;

    ws.send(JSON.stringify({
      type: 'status',
      channelId,
      name: channel.name,
      isPlaying: channel.isPlaying,
      currentTrack: channel.currentTrack ? {
        title: channel.currentTrack.title,
        filename: channel.currentTrack.filename
      } : null,
      volume: channel.volume,
      listeners: channel.listeners,
      playlist: channel.playlist.map((t, i) => ({
        index: i,
        title: t.title,
        filename: t.filename
      })),
      currentIndex: channel.currentIndex,
      ffmpegAvailable: this.ffmpegAvailable
    }));
  }

  sendMixerStatus(ws, mixerId) {
    if (!this.mixerManager) return;
    const mixer = this.mixerManager.getMixer(mixerId);
    if (!mixer) return;

    ws.send(JSON.stringify({
      type: 'mixerState',
      mixerId,
      state: mixer.toJSON(),
      ffmpegAvailable: this.ffmpegAvailable
    }));
  }

  stop() {
    if (this.wss) {
      this.wss.close();
    }
  }
}

module.exports = WebSocketServer;
