/* Local-first cloud sync for the trip manager.
 * Rule: an initialized device is authoritative. Cloud is backup/sync, not master.
 * A brand-new device with no local data may bootstrap from the cloud once.
 */
(function () {
  'use strict';

  var config = window.TRIP_CLOUD_CONFIG;
  var META_KEY = 'logistic_sync_meta';
  var syncing = false;
  var syncTimer = null;
  var applyingRemote = false;
  var HISTORY_LIMIT = 30;

  function status(message, isError) {
    var el = document.getElementById('cloud-status');
    if (!el) return;
    el.textContent = message;
    el.style.color = isError ? 'var(--danger)' : '#718096';
  }

  if (!config || !config.url || !config.anonKey || !window.supabase) {
    status('雲端設定尚未完成', true);
    return;
  }

  var client = window.supabase.createClient(config.url, config.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      flowType: 'pkce',
      detectSessionInUrl: false
    }
  });

  function clone(value, fallback) {
    try { return JSON.parse(JSON.stringify(value)); } catch (e) { return fallback; }
  }

  function readMeta() {
    try {
      var value = JSON.parse(localStorage.getItem(META_KEY) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch (e) { return {}; }
  }

  function writeMeta(meta) {
    try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) {}
  }

  function getDeviceId() {
    var meta = readMeta();
    if (!meta.deviceId) {
      meta.deviceId = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : ('device-' + Date.now() + '-' + Math.random().toString(36).slice(2));
      writeMeta(meta);
    }
    return meta.deviceId;
  }

  function ensureRecordIds() {
    var changed = false;
    var deviceId = getDeviceId();
    [DB.logs, DB.trash].forEach(function (items) {
      (items || []).forEach(function (record) {
        if (!record.syncId) {
          record.syncId = deviceId + ':' + String(record.id || Date.now());
          changed = true;
        }
      });
    });
    return changed;
  }

  function buildSnapshot() {
    return {
      version: 4,
      logs: clone(DB.logs, []),
      trash: clone(DB.trash, []),
      km: clone(DB.km, {}),
      price: clone(DB.price, {}),
      locations: clone(DB.locations, {}),
      savedAt: new Date().toISOString(),
      source: 'local-first'
    };
  }

  function snapshotForHistory(snapshot) {
    var copy = clone(snapshot, null);
    if (!copy) return null;
    delete copy.history;
    return copy;
  }

  function getHistory(remoteData) {
    return remoteData && Array.isArray(remoteData.history) ? remoteData.history : [];
  }

  function withHistory(snapshot, remoteData) {
    var history = getHistory(remoteData);
    var previous = snapshotForHistory(remoteData);
    if (previous && validSnapshot(previous)) {
      history.push({
        savedAt: previous.savedAt || new Date().toISOString(),
        logs: clone(previous.logs, []),
        trash: clone(previous.trash, []),
        km: clone(previous.km, {}),
        price: clone(previous.price, {}),
        locations: clone(previous.locations, {}),
        version: previous.version || 1,
        source: previous.source || 'cloud'
      });
    }
    var unique = [];
    var seen = {};
    history.slice().reverse().forEach(function (item) {
      var stamp = String(item && item.savedAt || '');
      var key = stamp + '|' + JSON.stringify([
        item && item.logs || [],
        item && item.trash || [],
        item && item.locations || {}
      ]);
      if (!seen[key]) { seen[key] = true; unique.push(item); }
    });
    unique = unique.slice(0, HISTORY_LIMIT).reverse();
    snapshot.history = unique;
    return snapshot;
  }

  function validSnapshot(value) {
    return value && typeof value === 'object' &&
      Array.isArray(value.logs) && Array.isArray(value.trash) &&
      value.km && value.price && (value.locations === undefined || typeof value.locations === 'object');
  }

  function localHasAnyData() {
    return (Array.isArray(DB.logs) && DB.logs.length > 0) ||
      (Array.isArray(DB.trash) && DB.trash.length > 0) ||
      (DB.km && Object.keys(DB.km).length > 0) ||
      (DB.price && Object.keys(DB.price).length > 0) ||
      (DB.locations && Object.keys(DB.locations).length > 0);
  }

  function isInitialized() {
    return !!readMeta().initialized;
  }

  function markInitialized() {
    var meta = readMeta();
    meta.initialized = true;
    meta.localChangedAt = new Date().toISOString();
    writeMeta(meta);
  }

  function markSynced() {
    var meta = readMeta();
    meta.initialized = true;
    meta.lastSyncedAt = new Date().toISOString();
    writeMeta(meta);
  }

  function updateAccountUI(user) {
    var signedOut = document.getElementById('cloud-signed-out');
    var signedIn = document.getElementById('cloud-signed-in');
    var userEl = document.getElementById('cloud-user');
    if (signedOut) signedOut.style.display = user ? 'none' : 'block';
    if (signedIn) signedIn.style.display = user ? 'block' : 'none';
    if (userEl) userEl.textContent = user ? ('已登入：' + (user.email || 'Supabase 使用者')) : '';
    status(user ? '已登入，等待同步' : '尚未登入');
  }

  function scheduleSync(delay) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { syncNow(false); }, delay || 800);
  }

  async function currentUser() {
    var result = await client.auth.getUser();
    return result.data && result.data.user ? result.data.user : null;
  }

  async function uploadLocal(user) {
    if (ensureRecordIds()) {
      applyingRemote = true;
      try {
        if (originalCommit() === false) throw new Error('本機資料無法儲存');
      } finally { applyingRemote = false; }
    }

    var remote = await client
      .from('trip_sync_state')
      .select('data, updated_at')
      .eq('user_id', user.id)
      .maybeSingle();
    if (remote.error) throw remote.error;

    var nextSnapshot = buildSnapshot();
    if (remote.data && remote.data.data && validSnapshot(remote.data.data)) {
      nextSnapshot = withHistory(nextSnapshot, remote.data.data);
    }

    var upload = await client.from('trip_sync_state').upsert({
      user_id: user.id,
      data: nextSnapshot,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });

    if (upload.error) throw upload.error;
    markSynced();
  }

  async function bootstrapFromCloud(user, remoteSnapshot) {
    if (!validSnapshot(remoteSnapshot)) {
      markSynced();
      return;
    }

    applyingRemote = true;
    try {
      DB.logs = clone(remoteSnapshot.logs, []);
      DB.trash = clone(remoteSnapshot.trash, []);
      DB.km = clone(remoteSnapshot.km, {});
      DB.price = clone(remoteSnapshot.price, {});
      DB.locations = clone(remoteSnapshot.locations, {});
      if (originalCommit() === false) throw new Error('雲端資料寫入本機失敗');
    } finally {
      applyingRemote = false;
    }

    await uploadLocal(user);
  }

  async function syncNow(showMessage) {
    if (syncing) return;

    var user;
    try { user = await currentUser(); }
    catch (e) {
      status('無法確認登入狀態', true);
      return;
    }

    if (!user) {
      if (showMessage) status('請先登入', true);
      return;
    }

    syncing = true;
    status('同步中…');

    try {
      var remote = await client
        .from('trip_sync_state')
        .select('data, updated_at')
        .eq('user_id', user.id)
        .maybeSingle();

      if (remote.error) throw remote.error;

      /* LOCAL-FIRST RULE:
       * Once this device has initialized, never download/merge remote data
       * merely because a login or automatic sync occurred. Upload local state.
       * Only a genuinely new, empty device bootstraps from cloud once.
       */
      if (isInitialized() || localHasAnyData()) {
        await uploadLocal(user);
        status('已同步（以本機資料為主）');
      } else if (remote.data && validSnapshot(remote.data.data)) {
        await bootstrapFromCloud(user, remote.data.data);
        status('已從雲端載入（首次登入）');
      } else {
        await uploadLocal(user);
        status('已建立雲端備份');
      }
    } catch (error) {
      status('同步失敗：' + (error.message || '請稍後再試'), true);
    } finally {
      applyingRemote = false;
      syncing = false;
    }
  }

  function renderRestoreList(history) {
    var area = document.getElementById('cloudRestoreArea');
    if (!area) return;
    if (!history.length) {
      area.innerHTML = '<div style="padding:12px;background:#f7fafc;border-radius:10px;color:#718096;text-align:center;">目前沒有可還原的雲端歷史版本。</div>';
      area.style.display = 'block';
      return;
    }
    var html = '<div style="background:#f7fafc;border-radius:10px;padding:10px;">' +
      '<div style="font-weight:800;color:#4a5568;margin-bottom:8px;">選擇要還原的雲端版本</div>' +
      '<div style="font-size:13px;color:#718096;margin-bottom:10px;">只會在你按下「還原」後寫入手機；目前手機資料會先保留在雲端歷史版本。</div>';
    history.slice().reverse().forEach(function (item) {
      var stamp = item && item.savedAt ? new Date(item.savedAt) : null;
      var label = stamp && !isNaN(stamp.getTime()) ? stamp.toLocaleString('zh-TW', { hour12:false }) : '未知時間';
      var restoreIndex = history.indexOf(item);
      var logs = Array.isArray(item && item.logs) ? item.logs.length : 0;
      var trash = Array.isArray(item && item.trash) ? item.trash.length : 0;
      html += '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:10px;margin-top:8px;">' +
        '<div style="font-weight:700;color:#2d3748;">☁️ ' + label + '</div>' +
        '<div style="font-size:13px;color:#718096;margin:5px 0 8px;">歷史：' + logs + ' 筆　回收桶：' + trash + ' 筆</div>' +
        '<button type="button" class="btn-sm" style="background:#805ad5;color:#fff;width:100%;" onclick="window.TripCloud.restoreHistory(' + restoreIndex + ')">還原這個版本</button>' +
        '</div>';
    });
    html += '<button type="button" class="btn-outline" style="margin-top:10px;width:100%;" onclick="document.getElementById(\'cloudRestoreArea\').style.display=\'none\'">關閉</button></div>';
    area.innerHTML = html;
    area.style.display = 'block';
  }

  var restoreHistoryCache = [];

  async function openRestore() {
    var user;
    try { user = await currentUser(); } catch (e) { status('無法確認登入狀態', true); return; }
    if (!user) { status('請先登入才能使用雲端還原', true); return; }
    status('正在讀取雲端歷史版本…');
    try {
      var remote = await client.from('trip_sync_state').select('data').eq('user_id', user.id).maybeSingle();
      if (remote.error) throw remote.error;
      restoreHistoryCache = getHistory(remote.data && remote.data.data);
      renderRestoreList(restoreHistoryCache);
      status('已載入雲端歷史版本');
    } catch (error) {
      status('讀取雲端歷史失敗：' + (error.message || '請稍後再試'), true);
    }
  }

  async function restoreHistory(index) {
    var item = restoreHistoryCache[index];
    if (!validSnapshot(item)) { status('這個雲端版本資料不完整', true); return; }
    var logs = Array.isArray(item.logs) ? item.logs.length : 0;
    var trash = Array.isArray(item.trash) ? item.trash.length : 0;
    if (!confirm('確定要還原這個雲端版本嗎？\n\n目前手機資料會被這個版本取代。\n歷史版本仍會保留在雲端。\n\n車趟：' + logs + ' 筆\n回收桶：' + trash + ' 筆')) return;

    var user;
    try { user = await currentUser(); } catch (e) { status('無法確認登入狀態', true); return; }
    if (!user) { status('請先登入', true); return; }

    try {
      status('正在還原…');
      applyingRemote = true;
      DB.logs = clone(item.logs, []);
      DB.trash = clone(item.trash, []);
      DB.km = clone(item.km, {});
      DB.price = clone(item.price, {});
      DB.locations = clone(item.locations, {});
      if (originalCommit() === false) throw new Error('手機資料儲存失敗');
      applyingRemote = false;
      markInitialized();
      await uploadLocal(user);
      if (typeof updateUI === 'function') updateUI();
      var area = document.getElementById('cloudRestoreArea');
      if (area) area.style.display = 'none';
      status('雲端版本已還原');
      alert('雲端資料已還原到手機。');
    } catch (error) {
      applyingRemote = false;
      status('還原失敗：' + (error.message || '請稍後再試'), true);
    }
  }

  async function sendOtp() {
    var input = document.getElementById('cloud-email');
    var email = input ? input.value.trim() : '';
    if (!email) { status('請輸入 Email', true); return; }
    status('正在寄送登入連結…');
    var options = {};
    if (/^https?:$/i.test(window.location.protocol)) {
      options.emailRedirectTo = window.location.href.split('#')[0];
    }
    var result = await client.auth.signInWithOtp({ email: email, options: options });
    if (result.error) status('寄送失敗：' + result.error.message, true);
    else status('登入連結已寄出，請至 Email 開啟');
  }

  async function signOut() {
    var result = await client.auth.signOut();
    if (result.error) status('登出失敗：' + result.error.message, true);
  }

  /* Wrap the existing local commit. Any local operation marks the device
   * initialized, then queues a local-first upload. */
  var originalCommit = commit;
  commit = function () {
    var result = originalCommit();
    if (result !== false && !applyingRemote) {
      markInitialized();
      scheduleSync(1200);
    }
    return result;
  };

  client.auth.onAuthStateChange(function (_event, session) {
    var user = session && session.user ? session.user : null;
    updateAccountUI(user);
    if (user) scheduleSync(400);
  });

  window.addEventListener('online', function () { scheduleSync(300); });

  window.TripCloud = {
    sendOtp: sendOtp,
    signOut: signOut,
    syncNow: syncNow,
    openRestore: openRestore,
    restoreHistory: restoreHistory
  };

  client.auth.getUser().then(function (result) {
    var user = result.data && result.data.user ? result.data.user : null;
    updateAccountUI(user);
    if (user) scheduleSync(400);
  }).catch(function () { status('無法連線至雲端', true); });
}());
