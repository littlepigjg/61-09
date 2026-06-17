const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const EventEmitter = require('events');
const StreamDistributor = require('./stream-distributor');

let ffmpeg = null;
let ffmpegAvailable = false;

try {
  ffmpeg = require('fluent-ffmpeg');
  try {
    execSync('ffmpeg -version 2>nul', { stdio: 'ignore' });
    ffmpegAvailable = true;
    console.log('[MIXER] ffmpeg 已检测到，混音功能可用');
  } catch (e) {
    console.log('[MIXER] 未检测到 ffmpeg，混音功能不可用');
  }
} catch (e) {
  console.log('[MIXER] fluent-ffmpeg 未安装，混音功能不可用');
}

class MixerChannel {
  constructor(id, name, description) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.isVirtual = true;
    this.isMixing = false;
    this.isRecording = false;
    this.recordFilePath = null;
    this.inputs = new Map();
    this.masterVolume = 1.0;
    this.listeners = 0;
    this.distributor = null;
    this.currentProcess = null;
    this.currentFFStream = null;
    this.recordProcess = null;
    this.recordStream = null;
    this.levelMonitorTimer = null;
    this.channelLevels = new Map();
    this._restartDebounceTimer = null;
    this._isRestarting = false;
    this._pendingRestart = false;
    this._crossfadeDuration = 0.5;
  }

  addInput(channelId, channelName) {
    if (!this.inputs.has(channelId)) {
      this.inputs.set(channelId, {
        channelId,
        channelName,
        volume: 1.0,
        pan: 0,
        muted: false,
        enabled: true
      });
      this.channelLevels.set(channelId, { left: 0, right: 0 });
    }
    return this.inputs.get(channelId);
  }

  removeInput(channelId) {
    this.inputs.delete(channelId);
    this.channelLevels.delete(channelId);
  }

  setInputVolume(channelId, volume) {
    const input = this.inputs.get(channelId);
    if (input) {
      input.volume = Math.max(0, Math.min(1, volume));
    }
  }

  setInputPan(channelId, pan) {
    const input = this.inputs.get(channelId);
    if (input) {
      input.pan = Math.max(-1, Math.min(1, pan));
    }
  }

  setInputMuted(channelId, muted) {
    const input = this.inputs.get(channelId);
    if (input) {
      input.muted = muted;
    }
  }

  setInputEnabled(channelId, enabled) {
    const input = this.inputs.get(channelId);
    if (input) {
      input.enabled = enabled;
    }
  }

  getInput(channelId) {
    return this.inputs.get(channelId);
  }

  getAllInputs() {
    return Array.from(this.inputs.values());
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      isVirtual: true,
      isMixing: this.isMixing,
      isRecording: this.isRecording,
      masterVolume: this.masterVolume,
      listeners: this.listeners,
      inputs: this.getAllInputs(),
      levels: Object.fromEntries(this.channelLevels)
    };
  }
}

class MixerManager extends EventEmitter {
  constructor(channelManager, audioStreamer, config) {
    super();
    this.channelManager = channelManager;
    this.audioStreamer = audioStreamer;
    this.config = config;
    this.mixers = new Map();
    this._inputStreamMap = new Map();

    this._initDefaultMixer();
  }

  _initDefaultMixer() {
    const defaultMixer = new MixerChannel(
      'mixer-main',
      '主混音台',
      '跨频道音频混音输出'
    );

    for (const ch of this.config.channels) {
      defaultMixer.addInput(ch.id, ch.name);
    }

    this.mixers.set(defaultMixer.id, defaultMixer);
  }

  createMixer(id, name, description, inputChannelIds = []) {
    if (this.mixers.has(id)) {
      return null;
    }

    const mixer = new MixerChannel(id, name, description);

    for (const chId of inputChannelIds) {
      const channel = this.channelManager.getChannel(chId);
      if (channel) {
        mixer.addInput(chId, channel.name);
      }
    }

    this.mixers.set(id, mixer);
    this.emit('mixerCreated', id, mixer.toJSON());
    return mixer.toJSON();
  }

  deleteMixer(mixerId) {
    const mixer = this.mixers.get(mixerId);
    if (!mixer) return false;
    if (mixerId === 'mixer-main') return false;

    this.stopRecording(mixerId);
    this.stopMixing(mixerId);

    if (mixer.distributor) {
      try { mixer.distributor.destroy(); } catch (e) {}
    }

    this.mixers.delete(mixerId);
    this.emit('mixerDeleted', mixerId);
    return true;
  }

  getMixer(mixerId) {
    return this.mixers.get(mixerId);
  }

  getAllMixers() {
    return Array.from(this.mixers.values()).map(m => m.toJSON());
  }

  isVirtualChannel(channelId) {
    return this.mixers.has(channelId);
  }

  getVirtualChannel(channelId) {
    const mixer = this.mixers.get(channelId);
    if (!mixer) return null;
    return {
      id: mixer.id,
      name: mixer.name,
      description: mixer.description,
      isPlaying: mixer.isMixing,
      currentTrack: { title: '混音输出', filename: 'mix' },
      listeners: mixer.listeners,
      volume: mixer.masterVolume,
      isVirtual: true
    };
  }

  getAllChannelsWithVirtual() {
    const normalChannels = this.channelManager.getAllChannels();
    const virtualChannels = Array.from(this.mixers.values()).map(m => ({
      id: m.id,
      name: m.name,
      description: m.description,
      isPlaying: m.isMixing,
      currentTrack: { title: '混音输出', filename: 'mix' },
      listeners: m.listeners,
      volume: m.masterVolume,
      isVirtual: true
    }));
    return [...normalChannels, ...virtualChannels];
  }

  setMasterVolume(mixerId, volume) {
    const mixer = this.mixers.get(mixerId);
    if (!mixer) return false;
    mixer.masterVolume = Math.max(0, Math.min(1, volume));
    this.emit('masterVolume', mixerId, mixer.masterVolume);
    this._scheduleRestart(mixerId);
    this._broadcastMixerState(mixerId);
    return true;
  }

  setInputVolume(mixerId, channelId, volume) {
    const mixer = this.mixers.get(mixerId);
    if (!mixer) return false;
    mixer.setInputVolume(channelId, volume);
    this.emit('inputChange', mixerId, channelId, 'volume', volume);
    this._scheduleRestart(mixerId);
    this._broadcastMixerState(mixerId);
    return true;
  }

  setInputPan(mixerId, channelId, pan) {
    const mixer = this.mixers.get(mixerId);
    if (!mixer) return false;
    mixer.setInputPan(channelId, pan);
    this.emit('inputChange', mixerId, channelId, 'pan', pan);
    this._scheduleRestart(mixerId);
    this._broadcastMixerState(mixerId);
    return true;
  }

  setInputMuted(mixerId, channelId, muted) {
    const mixer = this.mixers.get(mixerId);
    if (!mixer) return false;
    mixer.setInputMuted(channelId, muted);
    this.emit('inputChange', mixerId, channelId, 'muted', muted);
    this._scheduleRestart(mixerId);
    this._broadcastMixerState(mixerId);
    return true;
  }

  setInputEnabled(mixerId, channelId, enabled) {
    const mixer = this.mixers.get(mixerId);
    if (!mixer) return false;
    mixer.setInputEnabled(channelId, enabled);
    this.emit('inputChange', mixerId, channelId, 'enabled', enabled);
    this._scheduleRestart(mixerId);
    this._broadcastMixerState(mixerId);
    return true;
  }

  addMixerInput(mixerId, channelId) {
    const mixer = this.mixers.get(mixerId);
    if (!mixer) return false;

    const channel = this.channelManager.getChannel(channelId);
    if (!channel) return false;

    mixer.addInput(channelId, channel.name);
    this._scheduleRestart(mixerId);
    this._broadcastMixerState(mixerId);
    return true;
  }

  removeMixerInput(mixerId, channelId) {
    const mixer = this.mixers.get(mixerId);
    if (!mixer) return false;

    mixer.removeInput(channelId);
    this._scheduleRestart(mixerId);
    this._broadcastMixerState(mixerId);
    return true;
  }

  _scheduleRestart(mixerId) {
    const mixer = this.mixers.get(mixerId);
    if (!mixer || !mixer.isMixing) return;

    if (mixer._restartDebounceTimer) {
      clearTimeout(mixer._restartDebounceTimer);
    }

    mixer._restartDebounceTimer = setTimeout(() => {
      this._restartFFmpegMix(mixerId);
    }, 150);
  }

  startMixing(mixerId) {
    const mixer = this.mixers.get(mixerId);
    if (!mixer || mixer.isMixing) return false;
    if (!ffmpegAvailable) {
      console.error('[MIXER] 无法启动混音：ffmpeg 不可用');
      return false;
    }

    mixer.isMixing = true;

    if (!mixer.distributor) {
      mixer.distributor = new StreamDistributor();
    }

    this._startFFmpegMix(mixerId);
    this._startLevelMonitoring(mixerId);

    this.emit('mixingStart', mixerId);
    this._broadcastMixerState(mixerId);
    return true;
  }

  stopMixing(mixerId) {
    const mixer = this.mixers.get(mixerId);
    if (!mixer || !mixer.isMixing) return false;

    mixer.isMixing = false;

    if (mixer._restartDebounceTimer) {
      clearTimeout(mixer._restartDebounceTimer);
      mixer._restartDebounceTimer = null;
    }

    this._stopFFmpegMix(mixerId);
    this._stopLevelMonitoring(mixerId);

    if (mixer.isRecording) {
      this.stopRecording(mixerId);
    }

    this.emit('mixingStop', mixerId);
    this._broadcastMixerState(mixerId);
    return true;
  }

  _buildFFmpegArgs(mixer) {
    const enabledInputs = mixer.getAllInputs().filter(i => i.enabled);

    if (enabledInputs.length === 0) {
      return null;
    }

    const args = ['-y'];

    for (const input of enabledInputs) {
      args.push('-re', '-f', 'mp3', '-i', `http://localhost:${this.config.port}/stream/${input.channelId}`);
    }

    let filterComplex = '';
    const inputLabels = [];

    for (let i = 0; i < enabledInputs.length; i++) {
      const input = enabledInputs[i];
      const vol = input.muted ? 0 : input.volume;
      const panValue = input.pan;

      let panFilter;
      if (panValue < 0) {
        const leftGain = 1.0;
        const rightGain = 1 + panValue;
        panFilter = `pan=stereo|c0=c0*${vol * leftGain}|c1=c1*${vol * Math.max(0, rightGain)}`;
      } else if (panValue > 0) {
        const leftGain = 1 - panValue;
        const rightGain = 1.0;
        panFilter = `pan=stereo|c0=c0*${vol * Math.max(0, leftGain)}|c1=c1*${vol * rightGain}`;
      } else {
        panFilter = `volume=${vol}`;
      }

      filterComplex += `[${i}:a]${panFilter}[a${i}];`;
      inputLabels.push(`[a${i}]`);
    }

    const inputCount = enabledInputs.length;
    const normalizedVolume = inputCount > 0 ? (1 / Math.sqrt(inputCount)) : 1;
    filterComplex += `${inputLabels.join('')}amix=inputs=${inputCount}:duration=longest:dropout_transition=2,volume=${normalizedVolume},volume=${mixer.masterVolume}[out]`;

    args.push(
      '-filter_complex', filterComplex,
      '-map', '[out]',
      '-acodec', 'libmp3lame',
      '-ab', '192k',
      '-ar', '44100',
      '-ac', '2',
      '-f', 'mp3',
      'pipe:1'
    );

    return args;
  }

  _startFFmpegMix(mixerId) {
    const mixer = this.mixers.get(mixerId);
    if (!mixer) return;

    try {
      const args = this._buildFFmpegArgs(mixer);
      if (!args) {
        console.log('[MIXER] 没有启用的输入通道');
        return;
      }

      const ffmpegProcess = spawn('ffmpeg', args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      mixer.currentProcess = ffmpegProcess;

      const writable = mixer.distributor.getWritableStream();
      ffmpegProcess.stdout.pipe(writable, { end: false });

      let stderrBuffer = '';
      ffmpegProcess.stderr.on('data', (data) => {
        stderrBuffer += data.toString();
        const lines = stderrBuffer.split('\n');
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i];
          if (line.includes('error') && !line.includes('Statistics')) {
            console.log(`[MIXER-FFMPEG] ${line.trim()}`);
          }
        }
        stderrBuffer = lines[lines.length - 1];
      });

      ffmpegProcess.on('error', (err) => {
        console.error('[MIXER] ffmpeg 进程错误:', err.message);
      });

      ffmpegProcess.on('exit', (code) => {
        if (mixer.isMixing && code !== 0 && code !== null && !mixer._isRestarting) {
          console.log(`[MIXER] ffmpeg 退出，代码 ${code}，正在重启...`);
          setTimeout(() => {
            if (mixer.isMixing) {
              this._startFFmpegMix(mixerId);
            }
          }, 1000);
        }
      });

    } catch (err) {
      console.error('[MIXER] 启动混音失败:', err);
      mixer.isMixing = false;
    }
  }

  _restartFFmpegMix(mixerId) {
    const mixer = this.mixers.get(mixerId);
    if (!mixer || !mixer.isMixing) return;
    if (mixer._isRestarting) {
      mixer._pendingRestart = true;
      return;
    }

    mixer._isRestarting = true;

    try {
      const args = this._buildFFmpegArgs(mixer);
      if (!args) {
        mixer._isRestarting = false;
        return;
      }

      const oldProcess = mixer.currentProcess;
      const oldDistributor = mixer.distributor;

      const newDistributor = new StreamDistributor();

      const newProcess = spawn('ffmpeg', args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const writable = newDistributor.getWritableStream();
      newProcess.stdout.pipe(writable, { end: false });

      let stderrBuffer = '';
      newProcess.stderr.on('data', (data) => {
        stderrBuffer += data.toString();
      });

      newProcess.on('error', (err) => {
        console.error('[MIXER] 新 ffmpeg 进程错误:', err.message);
        mixer._isRestarting = false;
      });

      newProcess.stdout.once('data', () => {
        setTimeout(() => {
          if (mixer.isMixing) {
            mixer.currentProcess = newProcess;
            mixer.distributor = newDistributor;

            if (oldProcess) {
              try { oldProcess.kill('SIGKILL'); } catch (e) {}
            }
            if (oldDistributor) {
              try { oldDistributor.destroy(); } catch (e) {}
            }

            mixer._isRestarting = false;

            if (mixer._pendingRestart) {
              mixer._pendingRestart = false;
              setImmediate(() => this._restartFFmpegMix(mixerId));
            }
          }
        }, 100);
      });

      newProcess.on('exit', (code) => {
        if (mixer.isMixing && code !== 0 && code !== null) {
          console.log(`[MIXER] 新 ffmpeg 退出，代码 ${code}`);
          mixer._isRestarting = false;
        }
      });

    } catch (err) {
      console.error('[MIXER] 重启混音失败:', err);
      mixer._isRestarting = false;
    }
  }

  _stopFFmpegMix(mixerId) {
    const mixer = this.mixers.get(mixerId);
    if (!mixer) return;

    if (mixer._restartDebounceTimer) {
      clearTimeout(mixer._restartDebounceTimer);
      mixer._restartDebounceTimer = null;
    }

    if (mixer.currentProcess) {
      try {
        if (mixer.distributor) {
          try {
            mixer.currentProcess.stdout.unpipe(mixer.distributor.getWritableStream());
          } catch (e) {}
        }
        mixer.currentProcess.kill('SIGKILL');
      } catch (e) {}
      mixer.currentProcess = null;
    }
  }

  _startLevelMonitoring(mixerId) {
    const mixer = this.mixers.get(mixerId);
    if (!mixer) return;

    mixer.levelMonitorTimer = setInterval(() => {
      for (const [channelId, input] of mixer.inputs.entries()) {
        if (!input.enabled || input.muted) {
          mixer.channelLevels.set(channelId, { left: 0, right: 0 });
        } else {
          const baseLevel = input.volume * (0.5 + Math.random() * 0.5);
          let leftLevel = baseLevel;
          let rightLevel = baseLevel;
          if (input.pan < 0) {
            rightLevel = baseLevel * (1 + input.pan);
          } else if (input.pan > 0) {
            leftLevel = baseLevel * (1 - input.pan);
          }
          leftLevel = Math.max(0, Math.min(1, leftLevel));
          rightLevel = Math.max(0, Math.min(1, rightLevel));
          mixer.channelLevels.set(channelId, { left: leftLevel, right: rightLevel });
        }
      }
      this._broadcastLevels(mixerId);
    }, 100);
  }

  _stopLevelMonitoring(mixerId) {
    const mixer = this.mixers.get(mixerId);
    if (!mixer) return;

    if (mixer.levelMonitorTimer) {
      clearInterval(mixer.levelMonitorTimer);
      mixer.levelMonitorTimer = null;
    }
    for (const channelId of mixer.channelLevels.keys()) {
      mixer.channelLevels.set(channelId, { left: 0, right: 0 });
    }
  }

  _broadcastMixerState(mixerId) {
    const mixer = this.mixers.get(mixerId);
    if (!mixer) return;
    this.emit('mixerState', mixerId, mixer.toJSON());
  }

  _broadcastLevels(mixerId) {
    const mixer = this.mixers.get(mixerId);
    if (!mixer) return;
    this.emit('levelsUpdate', mixerId, Object.fromEntries(mixer.channelLevels));
  }

  startRecording(mixerId) {
    const mixer = this.mixers.get(mixerId);
    if (!mixer || !mixer.isMixing || mixer.isRecording) return false;
    if (!ffmpegAvailable) return false;

    try {
      const recordDir = path.resolve(path.join(this.config.musicBaseDir, '..', 'recordings'));
      if (!fs.existsSync(recordDir)) {
        fs.mkdirSync(recordDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const fileName = `mix_${mixerId}_${timestamp}.mp3`;
      const filePath = path.join(recordDir, fileName);

      const args = [
        '-y',
        '-f', 'mp3', '-i', `http://localhost:${this.config.port}/stream/${mixerId}`,
        '-acodec', 'libmp3lame',
        '-ab', '192k',
        '-ar', '44100',
        '-ac', '2',
        filePath
      ];

      const recordProcess = spawn('ffmpeg', args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      mixer.isRecording = true;
      mixer.recordFilePath = filePath;
      mixer.recordProcess = recordProcess;

      recordProcess.on('error', (err) => {
        console.error('[MIXER] 录制进程错误:', err.message);
        mixer.isRecording = false;
      });

      recordProcess.on('exit', (code) => {
        console.log(`[MIXER] 录制完成，保存至: ${filePath}`);
        mixer.isRecording = false;
        mixer.recordProcess = null;
      });

      this.emit('recordingStart', mixerId, filePath);
      this._broadcastMixerState(mixerId);
      return true;
    } catch (err) {
      console.error('[MIXER] 启动录制失败:', err);
      return false;
    }
  }

  stopRecording(mixerId) {
    const mixer = this.mixers.get(mixerId);
    if (!mixer || !mixer.isRecording) return false;

    try {
      if (mixer.recordProcess) {
        mixer.recordProcess.kill('SIGINT');
        setTimeout(() => {
          if (mixer.recordProcess) {
            try { mixer.recordProcess.kill('SIGKILL'); } catch (e) {}
          }
        }, 3000);
      }
    } catch (e) {}

    const savedPath = mixer.recordFilePath;
    mixer.isRecording = false;
    mixer.recordProcess = null;

    this.emit('recordingStop', mixerId, savedPath);
    this._broadcastMixerState(mixerId);
    return true;
  }

  createClientStream(mixerId, userId = null) {
    const mixer = this.mixers.get(mixerId);
    if (!mixer) return null;

    if (!mixer.distributor) {
      mixer.distributor = new StreamDistributor();
    }

    if (mixer.isMixing) {
    } else {
      this.startMixing(mixerId);
    }

    const clientStream = mixer.distributor.addClient();
    if (!clientStream) return null;

    mixer.listeners++;
    this.emit('listeners', mixerId, mixer.listeners);

    const handleClose = () => {
      mixer.listeners = Math.max(0, mixer.listeners - 1);
      this.emit('listeners', mixerId, mixer.listeners);
    };

    clientStream.once('close', handleClose);
    clientStream.once('error', handleClose);
    clientStream.once('finish', handleClose);

    return { stream: clientStream, connectionId: `mix_${Date.now()}_${Math.random().toString(36).slice(2)}` };
  }

  getListenerCount(mixerId) {
    const mixer = this.mixers.get(mixerId);
    return mixer ? mixer.listeners : 0;
  }

  shutdown() {
    for (const mixer of this.mixers.values()) {
      this.stopRecording(mixer.id);
      this.stopMixing(mixer.id);
      if (mixer.distributor) {
        try { mixer.distributor.destroy(); } catch (e) {}
      }
    }
  }
}

module.exports = MixerManager;
