const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const path = require('path');
const { execSync } = require('child_process');
const config = require('../config.json');
const ChannelManager = require('./channel-manager');
const AudioStreamer = require('./audio-streamer');
const WebSocketServer = require('./ws-server');
const MixerManager = require('./mixer-manager');

let ffmpegAvailable = false;
try {
  execSync('ffmpeg -version 2>nul', { stdio: 'ignore' });
  ffmpegAvailable = true;
} catch (e) {}

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason);
});

const app = express();
app.use(cors());

app.use((req, res, next) => {
  let userId = null;
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)listener_uid=([^;]+)/);
    if (match) {
      userId = match[1];
    }
  }
  if (!userId) {
    userId = crypto.randomUUID();
    res.cookie('listener_uid', userId, {
      maxAge: 24 * 60 * 60 * 1000,
      httpOnly: false,
      sameSite: 'lax'
    });
  }
  req.listenerUid = userId;
  next();
});

const rawBodyBuffer = (req, res, buf, encoding) => {
  if (buf && buf.length) {
    req.rawBody = buf.toString(encoding || 'utf8');
  }
};

app.use(express.json({ verify: rawBodyBuffer }));

const frontendPath = path.join(__dirname, '../../frontend');
app.use(express.static(frontendPath));

const channelManager = new ChannelManager(config);
channelManager.init();

const audioStreamer = new AudioStreamer(channelManager);

const mixerManager = new MixerManager(channelManager, audioStreamer, config);

const wsServer = new WebSocketServer(config.wsPort, channelManager, ffmpegAvailable, mixerManager);
wsServer.start();

app.get('/api/channels', (req, res) => {
  const channels = mixerManager.getAllChannelsWithVirtual();
  res.json(channels);
});

app.get('/api/mixers', (req, res) => {
  const mixers = mixerManager.getAllMixers();
  res.json(mixers);
});

app.get('/api/mixers/:mixerId', (req, res) => {
  const mixer = mixerManager.getMixer(req.params.mixerId);
  if (!mixer) {
    return res.status(404).json({ error: 'Mixer not found' });
  }
  res.json(mixer.toJSON());
});

app.post('/api/mixers/:mixerId/start', (req, res) => {
  const result = mixerManager.startMixing(req.params.mixerId);
  res.json({ success: result });
});

app.post('/api/mixers/:mixerId/stop', (req, res) => {
  const result = mixerManager.stopMixing(req.params.mixerId);
  res.json({ success: result });
});

app.post('/api/mixers/:mixerId/masterVolume', (req, res) => {
  const { volume } = req.body;
  if (volume === undefined) {
    return res.status(400).json({ error: 'Volume is required' });
  }
  const result = mixerManager.setMasterVolume(req.params.mixerId, volume);
  const mixer = mixerManager.getMixer(req.params.mixerId);
  res.json({ success: result, volume: mixer?.masterVolume });
});

app.post('/api/mixers/:mixerId/inputs/:channelId/volume', (req, res) => {
  const { volume } = req.body;
  if (volume === undefined) {
    return res.status(400).json({ error: 'Volume is required' });
  }
  const result = mixerManager.setInputVolume(req.params.mixerId, req.params.channelId, volume);
  res.json({ success: result });
});

app.post('/api/mixers/:mixerId/inputs/:channelId/pan', (req, res) => {
  const { pan } = req.body;
  if (pan === undefined) {
    return res.status(400).json({ error: 'Pan is required' });
  }
  const result = mixerManager.setInputPan(req.params.mixerId, req.params.channelId, pan);
  res.json({ success: result });
});

app.post('/api/mixers/:mixerId/inputs/:channelId/mute', (req, res) => {
  const { muted } = req.body;
  const result = mixerManager.setInputMuted(req.params.mixerId, req.params.channelId, muted);
  res.json({ success: result });
});

app.post('/api/mixers/:mixerId/inputs/:channelId/enable', (req, res) => {
  const { enabled } = req.body;
  const result = mixerManager.setInputEnabled(req.params.mixerId, req.params.channelId, enabled);
  res.json({ success: result });
});

app.post('/api/mixers/:mixerId/record/start', (req, res) => {
  const result = mixerManager.startRecording(req.params.mixerId);
  const mixer = mixerManager.getMixer(req.params.mixerId);
  res.json({ success: result, filePath: mixer?.recordFilePath });
});

app.post('/api/mixers/:mixerId/record/stop', (req, res) => {
  const result = mixerManager.stopRecording(req.params.mixerId);
  const mixer = mixerManager.getMixer(req.params.mixerId);
  res.json({ success: result, filePath: mixer?.recordFilePath });
});

app.post('/api/mixers', (req, res) => {
  const { id, name, description, inputChannels } = req.body;
  if (!id || !name) {
    return res.status(400).json({ error: 'id and name are required' });
  }
  const result = mixerManager.createMixer(id, name, description || '', inputChannels || []);
  if (!result) {
    return res.status(400).json({ error: 'Mixer already exists' });
  }
  res.json({ success: true, mixer: result });
});

app.delete('/api/mixers/:mixerId', (req, res) => {
  const result = mixerManager.deleteMixer(req.params.mixerId);
  if (!result) {
    return res.status(400).json({ error: 'Cannot delete mixer' });
  }
  res.json({ success: true });
});

app.post('/api/mixers/:mixerId/inputs', (req, res) => {
  const { channelId } = req.body;
  if (!channelId) {
    return res.status(400).json({ error: 'channelId is required' });
  }
  const result = mixerManager.addMixerInput(req.params.mixerId, channelId);
  if (!result) {
    return res.status(400).json({ error: 'Cannot add input' });
  }
  res.json({ success: true });
});

app.delete('/api/mixers/:mixerId/inputs/:channelId', (req, res) => {
  const result = mixerManager.removeMixerInput(req.params.mixerId, req.params.channelId);
  if (!result) {
    return res.status(400).json({ error: 'Cannot remove input' });
  }
  res.json({ success: true });
});

app.get('/api/channels/:channelId', (req, res) => {
  if (mixerManager.isVirtualChannel(req.params.channelId)) {
    const vChannel = mixerManager.getVirtualChannel(req.params.channelId);
    if (!vChannel) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    return res.json(vChannel);
  }

  const channel = channelManager.getChannel(req.params.channelId);
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }
  res.json({
    id: channel.id,
    name: channel.name,
    description: channel.description,
    isPlaying: channel.isPlaying,
    currentTrack: channel.currentTrack ? {
      title: channel.currentTrack.title,
      filename: channel.currentTrack.filename
    } : null,
    listeners: channel.listeners,
    volume: channel.volume,
    currentIndex: channel.currentIndex
  });
});

app.get('/api/channels/:channelId/playlist', (req, res) => {
  const channel = channelManager.getChannel(req.params.channelId);
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }
  const playlist = channelManager.getPlaylist(req.params.channelId);
  res.json(playlist.map((t, i) => ({
    index: i,
    title: t.title,
    filename: t.filename
  })));
});

app.post('/api/channels/:channelId/play', (req, res) => {
  const { index } = req.body || {};
  const track = channelManager.play(req.params.channelId, index);
  if (track === null) {
    return res.status(404).json({ error: 'No tracks available' });
  }
  res.json({ success: true, track });
});

app.post('/api/channels/:channelId/pause', (req, res) => {
  const result = channelManager.pause(req.params.channelId);
  res.json({ success: result });
});

app.post('/api/channels/:channelId/resume', (req, res) => {
  const result = channelManager.resume(req.params.channelId);
  res.json({ success: result });
});

app.post('/api/channels/:channelId/next', (req, res) => {
  const track = channelManager.next(req.params.channelId);
  res.json({ success: true, track });
});

app.post('/api/channels/:channelId/prev', (req, res) => {
  const track = channelManager.prev(req.params.channelId);
  res.json({ success: true, track });
});

app.post('/api/channels/:channelId/volume', (req, res) => {
  const { volume } = req.body;
  if (volume === undefined) {
    return res.status(400).json({ error: 'Volume is required' });
  }
  const result = channelManager.setVolume(req.params.channelId, volume);
  res.json({ success: result, volume: channelManager.getChannel(req.params.channelId)?.volume });
});

app.get('/stream/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  const userId = req.listenerUid;

  if (mixerManager.isVirtualChannel(channelId)) {
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Accept-Ranges', 'none');
    res.status(200);

    const result = mixerManager.createClientStream(channelId, userId);
    if (!result) {
      res.end();
      return;
    }

    const { stream: clientStream, connectionId } = result;
    res.setHeader('X-Connection-Id', connectionId);

    clientStream.pipe(res);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        clientStream.unpipe(res);
      } catch (e) {}
      try {
        clientStream.destroy();
      } catch (e) {}
    };

    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);
    res.on('finish', cleanup);
    clientStream.on('error', cleanup);
    return;
  }

  const channel = channelManager.getChannel(channelId);
  if (!channel) {
    return res.status(404).send('Channel not found');
  }

  let contentType = 'audio/mpeg';
  if (!ffmpegAvailable) {
    const currentTrack = channelManager.getCurrentTrack(channelId);
    if (currentTrack) {
      const ext = currentTrack.filename.split('.').pop().toLowerCase();
      if (ext === 'wav') contentType = 'audio/wav';
      else if (ext === 'ogg') contentType = 'audio/ogg';
      else if (ext === 'flac') contentType = 'audio/flac';
      else if (ext === 'm4a' || ext === 'aac') contentType = 'audio/aac';
    }
  }

  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Accept-Ranges', 'none');
  res.status(200);

  const result = audioStreamer.createClientStream(channelId, userId, true);
  if (!result) {
    res.end();
    return;
  }

  const { stream: clientStream, connectionId } = result;
  res.setHeader('X-Connection-Id', connectionId);

  clientStream.pipe(res);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      clientStream.unpipe(res);
    } catch (e) {}
    try {
      clientStream.destroy();
    } catch (e) {}
  };

  req.on('close', cleanup);
  req.on('aborted', cleanup);
  res.on('close', cleanup);
  res.on('finish', cleanup);
  clientStream.on('error', cleanup);
});

app.post('/api/listeners/leave', (req, res) => {
  let body = req.body;
  if ((!body || Object.keys(body).length === 0) && req.rawBody) {
    try {
      body = JSON.parse(req.rawBody);
    } catch (e) {}
  }
  const userId = req.listenerUid;
  if (!userId) {
    return res.json({ success: false });
  }
  const affected = audioStreamer.removeAllStreamsForUser(userId);
  res.json({ success: true, affectedChannels: affected, userId });
});

app.post('/api/listeners/heartbeat', (req, res) => {
  const { connectionId, channelId } = req.body || {};
  let success = false;
  if (connectionId) {
    success = audioStreamer.listenerManager.touch(connectionId, channelId);
  }
  res.json({ success });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/config', (req, res) => {
  res.json({
    ffmpegAvailable: ffmpegAvailable,
    port: config.port,
    wsPort: config.wsPort
  });
});

app.listen(config.port, () => {
  console.log(`\n=== 内网音频广播服务已启动 ===`);
  console.log(`HTTP 服务端口: ${config.port}`);
  console.log(`WebSocket 端口: ${config.wsPort}`);
  console.log(`音乐目录: ${path.resolve(config.musicBaseDir)}`);
  console.log(`\n频道列表:`);
  for (const ch of config.channels) {
    console.log(`  [${ch.name}] - /stream/${ch.id}`);
    console.log(`    目录: ${path.join(config.musicBaseDir, ch.dir)}`);
  }
  console.log(`  [主混音台] - /stream/mixer-main (虚拟混音频道)`);
  console.log(`\n前端页面: http://localhost:${config.port}/`);
  console.log(`DJ 控制台: http://localhost:${config.port}/dj.html`);
  console.log(`混音台: http://localhost:${config.port}/mixer.html`);
  console.log(`\n提示: 请确保系统已安装 ffmpeg`);
});

process.on('SIGINT', () => {
  console.log('\n正在关闭服务...');
  mixerManager.shutdown();
  audioStreamer.shutdown();
  wsServer.stop();
  process.exit(0);
});
