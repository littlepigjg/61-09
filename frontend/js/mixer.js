class MixerPanel {
  constructor() {
    this.currentMixerId = 'mixer-main';
    this.ws = null;
    this.mixerState = null;
    this.levels = {};
    this.channelLevels = {};
    this.debounceTimers = {};
    this.allChannels = [];
    this.allMixers = [];
    this.isPreviewing = false;
    this.previewAudio = null;
    this.mixStartTime = null;
    this.durationTimer = null;

    this.init();
  }

  init() {
    this.previewAudio = document.getElementById('previewAudio');
    this.mixerName = document.getElementById('mixerName');
    this.mixerDesc = document.getElementById('mixerDesc');
    this.mixerStatus = document.getElementById('mixerStatus');
    this.recordStatus = document.getElementById('recordStatus');
    this.startMixBtn = document.getElementById('startMixBtn');
    this.stopMixBtn = document.getElementById('stopMixBtn');
    this.startRecordBtn = document.getElementById('startRecordBtn');
    this.stopRecordBtn = document.getElementById('stopRecordBtn');
    this.togglePreviewBtn = document.getElementById('togglePreviewBtn');
    this.deleteMixerBtn = document.getElementById('deleteMixerBtn');
    this.masterVolume = document.getElementById('masterVolume');
    this.masterVolumeValue = document.getElementById('masterVolumeValue');
    this.masterFaderFill = document.getElementById('masterFaderFill');
    this.masterMeterLeft = document.getElementById('masterMeterLeft');
    this.masterMeterRight = document.getElementById('masterMeterRight');
    this.masterDbLeft = document.getElementById('masterDbLeft');
    this.masterDbRight = document.getElementById('masterDbRight');
    this.mixerListenerCount = document.getElementById('mixerListenerCount');
    this.inputChannelCount = document.getElementById('inputChannelCount');
    this.mixDuration = document.getElementById('mixDuration');
    this.mixerChannels = document.getElementById('mixerChannels');
    this.mixerList = document.getElementById('mixerList');
    this.availableChannels = document.getElementById('availableChannels');

    this.loadAllData();
    this.connectWebSocket();
    this.bindEvents();
  }

  async loadAllData() {
    try {
      const [channelsRes, mixersRes] = await Promise.all([
        fetch(`${CONFIG.API_BASE}/api/channels`),
        fetch(`${CONFIG.API_BASE}/api/mixers`)
      ]);
      this.allChannels = await channelsRes.json();
      this.allMixers = await mixersRes.json();

      this.renderMixerList();
      this.renderAvailableChannels();
      this.loadMixerState();
    } catch (err) {
      console.error('Failed to load data:', err);
    }
  }

  async loadMixerState() {
    try {
      const response = await fetch(`${CONFIG.API_BASE}/api/mixers/${this.currentMixerId}`);
      const state = await response.json();
      this.handleMixerState(state);
    } catch (err) {
      console.error('Failed to load mixer state:', err);
    }
  }

  connectWebSocket() {
    this.ws = new WebSocket(CONFIG.WS_URL);

    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({
        action: 'joinMixer',
        mixerId: this.currentMixerId
      }));
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      this.handleWebSocketMessage(data);
    };

    this.ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };

    this.ws.onclose = () => {
    };
  }

  handleWebSocketMessage(data) {
    switch (data.type) {
      case 'mixerState':
        this.handleMixerState(data.state);
        break;
      case 'levelsUpdate':
        this.handleLevelsUpdate(data.levels);
        break;
      case 'listenersChange':
        this.mixerListenerCount.textContent = data.listeners;
        break;
      case 'mixerCreated':
        this.allMixers.push(data.state);
        this.renderMixerList();
        break;
      case 'mixerDeleted':
        this.allMixers = this.allMixers.filter(m => m.id !== data.mixerId);
        this.renderMixerList();
        if (this.currentMixerId === data.mixerId) {
          this.switchMixer('mixer-main');
        }
        break;
    }
  }

  handleMixerState(state) {
    this.mixerState = state;
    this.mixerName.textContent = state.name;
    this.mixerDesc.textContent = state.description;
    this.mixerListenerCount.textContent = state.listeners;
    this.inputChannelCount.textContent = state.inputs.length;

    this.updateStatusBadge(state.isMixing, state.isRecording);
    this.updateControlButtons(state.isMixing, state.isRecording);

    const volPercent = Math.round(state.masterVolume * 100);
    this.masterVolume.value = volPercent;
    this.masterVolumeValue.textContent = `${volPercent}%`;
    this.masterFaderFill.style.height = `${volPercent}%`;

    this.deleteMixerBtn.style.display = state.id === 'mixer-main' ? 'none' : 'inline-block';

    this.renderInputChannels(state.inputs);

    if (state.isMixing && !this.mixStartTime) {
      this.mixStartTime = Date.now();
      this.startDurationTimer();
    } else if (!state.isMixing) {
      this.mixStartTime = null;
      this.stopDurationTimer();
      this.mixDuration.textContent = '00:00';
    }
  }

  handleLevelsUpdate(levels) {
    this.channelLevels = levels;

    let totalLeft = 0;
    let totalRight = 0;
    let count = 0;

    for (const [channelId, level] of Object.entries(levels)) {
      totalLeft += level.left;
      totalRight += level.right;
      count++;
      this.updateChannelMeter(channelId, level.left, level.right);
    }

    if (count > 0) {
      const avgLeft = totalLeft / count;
      const avgRight = totalRight / count;
      const masterVol = this.mixerState?.masterVolume || 1;
      this.updateVerticalMeter(this.masterMeterLeft, this.masterDbLeft, avgLeft * masterVol);
      this.updateVerticalMeter(this.masterMeterRight, this.masterDbRight, avgRight * masterVol);
    } else {
      this.updateVerticalMeter(this.masterMeterLeft, this.masterDbLeft, 0);
      this.updateVerticalMeter(this.masterMeterRight, this.masterDbRight, 0);
    }
  }

  updateStatusBadge(isMixing, isRecording) {
    this.mixerStatus.classList.remove('playing', 'paused', 'stopped');
    if (isMixing) {
      this.mixerStatus.textContent = '混音中';
      this.mixerStatus.classList.add('playing');
    } else {
      this.mixerStatus.textContent = '未启动';
      this.mixerStatus.classList.add('stopped');
    }

    if (isRecording) {
      this.recordStatus.style.display = 'inline-block';
    } else {
      this.recordStatus.style.display = 'none';
    }
  }

  updateControlButtons(isMixing, isRecording) {
    this.startMixBtn.disabled = isMixing;
    this.stopMixBtn.disabled = !isMixing;
    this.startRecordBtn.disabled = !isMixing || isRecording;
    this.stopRecordBtn.disabled = !isRecording;

    if (isMixing) {
      this.togglePreviewBtn.classList.add('active');
    }
  }

  renderMixerList() {
    this.mixerList.innerHTML = this.allMixers.map(mixer => `
      <div class="mixer-list-item ${mixer.id === this.currentMixerId ? 'active' : ''}" data-mixer-id="${mixer.id}">
        <span class="mixer-item-icon">🎚️</span>
        <div class="mixer-item-info">
          <span class="mixer-item-name">${mixer.name}</span>
          <span class="mixer-item-status">${mixer.isMixing ? '● 运行中' : '○ 已停止'}</span>
        </div>
      </div>
    `).join('');

    this.mixerList.querySelectorAll('.mixer-list-item').forEach(item => {
      item.addEventListener('click', () => {
        const mixerId = item.dataset.mixerId;
        this.switchMixer(mixerId);
      });
    });
  }

  renderAvailableChannels() {
    const normalChannels = this.allChannels.filter(ch => !ch.isVirtual);
    this.availableChannels.innerHTML = normalChannels.map(channel => `
      <div class="channel-item-small" data-channel-id="${channel.id}" draggable="true">
        <span class="channel-status-dot ${channel.isPlaying ? 'playing' : ''}"></span>
        <span class="channel-name-small">${channel.name}</span>
        <button class="btn-add-channel" data-channel-id="${channel.id}">+</button>
      </div>
    `).join('');

    this.availableChannels.querySelectorAll('.btn-add-channel').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const channelId = btn.dataset.channelId;
        this.addInputChannel(channelId);
      });
    });
  }

  switchMixer(mixerId) {
    if (this.currentMixerId === mixerId) return;

    if (this.isPreviewing) {
      this.togglePreview();
    }

    this.currentMixerId = mixerId;
    this.channelLevels = {};
    this.mixStartTime = null;
    this.stopDurationTimer();

    this.ws.send(JSON.stringify({
      action: 'joinMixer',
      mixerId: mixerId
    }));

    this.loadMixerState();
    this.renderMixerList();
  }

  renderInputChannels(inputs) {
    this.mixerChannels.innerHTML = inputs.map(input => this.renderChannel(input)).join('');

    inputs.forEach(input => {
      this.bindChannelEvents(input.channelId);
      const level = this.channelLevels[input.channelId] || { left: 0, right: 0 };
      this.updateChannelMeter(input.channelId, level.left, level.right);
    });
  }

  renderChannel(input) {
    const panPercent = Math.round((input.pan + 1) * 50);
    const panLabel = input.pan === 0 ? 'C' : (input.pan < 0 ? `L${Math.abs(Math.round(input.pan * 100))}` : `R${Math.round(input.pan * 100)}`);
    const volPercent = Math.round(input.volume * 100);

    return `
      <div class="mixer-channel ${input.enabled ? '' : 'disabled'} ${input.muted ? 'muted' : ''}" data-channel-id="${input.channelId}">
        <div class="channel-header">
          <div class="channel-title">
            <span class="channel-color-dot"></span>
            <h3>${input.channelName}</h3>
          </div>
          <div class="channel-controls-header">
            <label class="toggle-switch small">
              <input type="checkbox" class="ch-enable" data-channel="${input.channelId}" ${input.enabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
            <button class="btn-remove-channel" data-channel="${input.channelId}" title="移除通道">×</button>
          </div>
        </div>

        <div class="channel-body">
          <div class="channel-fader-section">
            <div class="channel-fader">
              <div class="fader-track small">
                <div class="fader-fill ch-fader-fill" style="height: ${volPercent}%"></div>
                <input type="range" class="fader-input vertical ch-volume" min="0" max="100" value="${volPercent}" data-channel="${input.channelId}" orient="vertical">
              </div>
              <span class="fader-label">音量</span>
              <span class="fader-value ch-volume-value">${volPercent}%</span>
            </div>
          </div>

          <div class="channel-meters-section">
            <div class="stereo-meter channel-meter">
              <div class="meter-channel">
                <span class="meter-label">L</span>
                <div class="meter-bar vertical small">
                  <div class="meter-fill meter-left ch-meter-l" style="height: 0%"></div>
                </div>
              </div>
              <div class="meter-channel">
                <span class="meter-label">R</span>
                <div class="meter-bar vertical small">
                  <div class="meter-fill meter-right ch-meter-r" style="height: 0%"></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="channel-footer">
          <div class="channel-pan-control">
            <span class="control-label">声像</span>
            <div class="pan-control">
              <span class="pan-label">L</span>
              <input type="range" class="ch-pan" min="0" max="100" value="${panPercent}" data-channel="${input.channelId}">
              <span class="pan-label">R</span>
            </div>
            <span class="ch-pan-value">${panLabel}</span>
          </div>

          <div class="channel-actions">
            <button class="mute-btn ${input.muted ? 'active' : ''}" data-channel="${input.channelId}">
              ${input.muted ? '🔇' : '🔊'}
            </button>
            <button class="solo-btn" data-channel="${input.channelId}" title="独奏">
              S
            </button>
          </div>
        </div>
      </div>
    `;
  }

  bindChannelEvents(channelId) {
    const channelEl = this.mixerChannels.querySelector(`[data-channel-id="${channelId}"]`);
    if (!channelEl) return;

    const volumeSlider = channelEl.querySelector('.ch-volume');
    const panSlider = channelEl.querySelector('.ch-pan');
    const muteBtn = channelEl.querySelector('.mute-btn');
    const enableToggle = channelEl.querySelector('.ch-enable');
    const removeBtn = channelEl.querySelector('.btn-remove-channel');

    if (volumeSlider) {
      volumeSlider.addEventListener('input', (e) => {
        const value = parseInt(e.target.value);
        const valueEl = channelEl.querySelector('.ch-volume-value');
        const fillEl = channelEl.querySelector('.ch-fader-fill');
        if (valueEl) valueEl.textContent = `${value}%`;
        if (fillEl) fillEl.style.height = `${value}%`;
        this.debounce(`vol-${channelId}`, () => {
          this.setInputVolume(channelId, value / 100);
        }, 50);
      });
    }

    if (panSlider) {
      panSlider.addEventListener('input', (e) => {
        const value = parseInt(e.target.value);
        const pan = (value - 50) / 50;
        const panLabel = pan === 0 ? 'C' : (pan < 0 ? `L${Math.abs(Math.round(pan * 100))}` : `R${Math.round(pan * 100)}`);
        const valueEl = channelEl.querySelector('.ch-pan-value');
        if (valueEl) valueEl.textContent = panLabel;
        this.debounce(`pan-${channelId}`, () => {
          this.setInputPan(channelId, pan);
        }, 50);
      });
    }

    if (muteBtn) {
      muteBtn.addEventListener('click', () => {
        const isMuted = muteBtn.classList.contains('active');
        this.setInputMuted(channelId, !isMuted);
      });
    }

    if (enableToggle) {
      enableToggle.addEventListener('change', (e) => {
        this.setInputEnabled(channelId, e.target.checked);
      });
    }

    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        this.removeInputChannel(channelId);
      });
    }
  }

  updateChannelMeter(channelId, leftLevel, rightLevel) {
    const channelEl = this.mixerChannels.querySelector(`[data-channel-id="${channelId}"]`);
    if (!channelEl) return;

    const meterL = channelEl.querySelector('.ch-meter-l');
    const meterR = channelEl.querySelector('.ch-meter-r');

    if (meterL) {
      const pct = Math.max(0, Math.min(100, leftLevel * 100));
      meterL.style.height = `${pct}%`;
    }
    if (meterR) {
      const pct = Math.max(0, Math.min(100, rightLevel * 100));
      meterR.style.height = `${pct}%`;
    }
  }

  updateVerticalMeter(fillEl, dbEl, level) {
    const pct = Math.max(0, Math.min(100, level * 100));
    fillEl.style.height = `${pct}%`;

    if (level <= 0) {
      dbEl.textContent = '-∞';
    } else {
      const db = 20 * Math.log10(level);
      dbEl.textContent = db > -60 ? `${db.toFixed(1)} dB` : '-∞';
    }
  }

  debounce(key, fn, delay) {
    if (this.debounceTimers[key]) {
      clearTimeout(this.debounceTimers[key]);
    }
    this.debounceTimers[key] = setTimeout(fn, delay);
  }

  sendMixerControl(command, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(JSON.stringify({
      action: 'mixerControl',
      mixerId: this.currentMixerId,
      command: command,
      params: params
    }));
  }

  startMixing() {
    this.sendMixerControl('start');
  }

  stopMixing() {
    this.sendMixerControl('stop');
  }

  startRecording() {
    this.sendMixerControl('startRecord');
  }

  stopRecording() {
    this.sendMixerControl('stopRecord');
  }

  setMasterVolume(value) {
    this.sendMixerControl('masterVolume', { volume: value });
  }

  setInputVolume(channelId, volume) {
    this.sendMixerControl('inputVolume', { channelId, volume });
  }

  setInputPan(channelId, pan) {
    this.sendMixerControl('inputPan', { channelId, pan });
  }

  setInputMuted(channelId, muted) {
    this.sendMixerControl('inputMute', { channelId, muted });
  }

  setInputEnabled(channelId, enabled) {
    this.sendMixerControl('inputEnable', { channelId, enabled });
  }

  async addInputChannel(channelId) {
    try {
      const response = await fetch(`${CONFIG.API_BASE}/api/mixers/${this.currentMixerId}/inputs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId })
      });
      const result = await response.json();
      if (result.success) {
        this.loadMixerState();
      }
    } catch (err) {
      console.error('Failed to add input channel:', err);
    }
  }

  async removeInputChannel(channelId) {
    try {
      const response = await fetch(`${CONFIG.API_BASE}/api/mixers/${this.currentMixerId}/inputs/${channelId}`, {
        method: 'DELETE'
      });
      const result = await response.json();
      if (result.success) {
        this.loadMixerState();
      }
    } catch (err) {
      console.error('Failed to remove input channel:', err);
    }
  }

  togglePreview() {
    if (this.isPreviewing) {
      this.previewAudio.pause();
      this.previewAudio.src = '';
      this.isPreviewing = false;
      this.togglePreviewBtn.classList.remove('active');
      this.togglePreviewBtn.textContent = '👂 监听预览';
    } else {
      this.previewAudio.src = `${CONFIG.API_BASE}/stream/${this.currentMixerId}`;
      this.previewAudio.volume = 0.8;
      this.previewAudio.play().catch(err => {
        console.error('Failed to play preview:', err);
        alert('无法播放预览，请确保混音已启动');
      });
      this.isPreviewing = true;
      this.togglePreviewBtn.classList.add('active');
      this.togglePreviewBtn.textContent = '🔇 停止监听';
    }
  }

  showAddMixerModal() {
    const modal = document.getElementById('addMixerModal');
    const checkboxGroup = document.getElementById('newMixerChannels');
    const normalChannels = this.allChannels.filter(ch => !ch.isVirtual);

    checkboxGroup.innerHTML = normalChannels.map(ch => `
      <label class="checkbox-item">
        <input type="checkbox" value="${ch.id}" class="new-mixer-channel-checkbox">
        <span>${ch.name}</span>
      </label>
    `).join('');

    modal.style.display = 'flex';
    document.getElementById('newMixerId').value = '';
    document.getElementById('newMixerName').value = '';
    document.getElementById('newMixerDesc').value = '';
  }

  hideAddMixerModal() {
    document.getElementById('addMixerModal').style.display = 'none';
  }

  async createMixer() {
    const id = document.getElementById('newMixerId').value.trim();
    const name = document.getElementById('newMixerName').value.trim();
    const description = document.getElementById('newMixerDesc').value.trim();

    if (!id || !name) {
      alert('请填写混音台ID和名称');
      return;
    }

    const checkboxes = document.querySelectorAll('.new-mixer-channel-checkbox:checked');
    const inputChannels = Array.from(checkboxes).map(cb => cb.value);

    try {
      const response = await fetch(`${CONFIG.API_BASE}/api/mixers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, description, inputChannels })
      });
      const result = await response.json();
      if (result.success) {
        this.hideAddMixerModal();
        this.switchMixer(id);
      } else {
        alert('创建失败：' + (result.error || '未知错误'));
      }
    } catch (err) {
      console.error('Failed to create mixer:', err);
      alert('创建失败');
    }
  }

  async deleteMixer() {
    if (this.currentMixerId === 'mixer-main') return;

    if (!confirm(`确定要删除混音台"${this.mixerState.name}"吗？`)) {
      return;
    }

    try {
      const response = await fetch(`${CONFIG.API_BASE}/api/mixers/${this.currentMixerId}`, {
        method: 'DELETE'
      });
      const result = await response.json();
      if (result.success) {
        this.switchMixer('mixer-main');
      } else {
        alert('删除失败');
      }
    } catch (err) {
      console.error('Failed to delete mixer:', err);
      alert('删除失败');
    }
  }

  showAddChannelModal() {
    const modal = document.getElementById('addChannelModal');
    const list = document.getElementById('channelSelectList');
    const currentInputIds = new Set(this.mixerState?.inputs?.map(i => i.channelId) || []);
    const normalChannels = this.allChannels.filter(ch => !ch.isVirtual && !currentInputIds.has(ch.id));

    if (normalChannels.length === 0) {
      list.innerHTML = '<p class="empty-text">没有可添加的频道</p>';
    } else {
      list.innerHTML = normalChannels.map(ch => `
        <div class="channel-select-item" data-channel-id="${ch.id}">
          <span class="channel-status-dot ${ch.isPlaying ? 'playing' : ''}"></span>
          <span class="channel-name">${ch.name}</span>
          <span class="channel-desc">${ch.description || ''}</span>
          <button class="btn-add-small">添加</button>
        </div>
      `).join('');

      list.querySelectorAll('.channel-select-item').forEach(item => {
        item.querySelector('.btn-add-small').addEventListener('click', () => {
          const channelId = item.dataset.channelId;
          this.addInputChannel(channelId);
          this.hideAddChannelModal();
        });
      });
    }

    modal.style.display = 'flex';
  }

  hideAddChannelModal() {
    document.getElementById('addChannelModal').style.display = 'none';
  }

  resetAllChannels() {
    if (!confirm('确定要重置所有通道参数吗？')) return;

    const inputs = this.mixerState?.inputs || [];
    inputs.forEach(input => {
      this.setInputVolume(input.channelId, 1.0);
      this.setInputPan(input.channelId, 0);
      this.setInputMuted(input.channelId, false);
    });
    this.setMasterVolume(1.0);
  }

  startDurationTimer() {
    this.stopDurationTimer();
    this.durationTimer = setInterval(() => {
      if (this.mixStartTime) {
        const elapsed = Math.floor((Date.now() - this.mixStartTime) / 1000);
        const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
        const secs = (elapsed % 60).toString().padStart(2, '0');
        this.mixDuration.textContent = `${mins}:${secs}`;
      }
    }, 1000);
  }

  stopDurationTimer() {
    if (this.durationTimer) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }
  }

  bindEvents() {
    this.startMixBtn.addEventListener('click', () => {
      this.startMixing();
    });

    this.stopMixBtn.addEventListener('click', () => {
      this.stopMixing();
    });

    this.startRecordBtn.addEventListener('click', () => {
      this.startRecording();
    });

    this.stopRecordBtn.addEventListener('click', () => {
      this.stopRecording();
    });

    this.togglePreviewBtn.addEventListener('click', () => {
      this.togglePreview();
    });

    this.deleteMixerBtn.addEventListener('click', () => {
      this.deleteMixer();
    });

    this.masterVolume.addEventListener('input', (e) => {
      const value = parseInt(e.target.value);
      this.masterVolumeValue.textContent = `${value}%`;
      this.masterFaderFill.style.height = `${value}%`;
      this.debounce('master-vol', () => {
        this.setMasterVolume(value / 100);
      }, 50);
    });

    document.getElementById('addMixerBtn').addEventListener('click', () => {
      this.showAddMixerModal();
    });

    document.getElementById('cancelAddMixer').addEventListener('click', () => {
      this.hideAddMixerModal();
    });

    document.getElementById('confirmAddMixer').addEventListener('click', () => {
      this.createMixer();
    });

    document.getElementById('addChannelBtn').addEventListener('click', () => {
      this.showAddChannelModal();
    });

    document.getElementById('cancelAddChannel').addEventListener('click', () => {
      this.hideAddChannelModal();
    });

    document.getElementById('resetAllBtn').addEventListener('click', () => {
      this.resetAllChannels();
    });

    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.style.display = 'none';
        }
      });
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new MixerPanel();
});
