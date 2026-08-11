/* Local-first personal sync for the existing trip database. */
(function () {
  'use strict';

  var config = window.TRIP_CLOUD_CONFIG;
  var status = function (message, isError) {
    var el = document.getElementById('cloud-status');
    if (!el) return;
    el.textContent = message;
    el.style.color = isError ? 'var(--danger)' : '#718096';
  };

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

  var META_KEY = 'logistic_sync_meta';
  var syncing = false;
  var applyingRemote = false;
  var syncTimer;

  function readMeta() {
    try {
      var value = JSON.parse(localStorage.getItem(META_KEY) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch (e) {
      return {};
    }
  }

  function writeMeta(meta) {
    try {
      localStorage.setItem(META_KEY, JSON.stringify(meta));
    } catch (e) {}
  }

  function getDeviceId() {
    var meta = readMeta();

    if (!meta.deviceId) {
      meta.deviceId =
        (window.crypto && window.crypto.randomUUID)
          ? window.crypto.randomUUID()
          : ('device-' + Date.now() + '-' +
             Math.random().toString(36).slice(2));

      writeMeta(meta);
    }

    return meta.deviceId;
  }

  function timeValue(value) {
    if (typeof value === 'number' && isFinite(value)) return value;

    var number = Number(value);
    if (isFinite(number) && number > 0) return number;

    var parsed = Date.parse(value || '');
    return isFinite(parsed) ? parsed : 0;
  }

  function recordKey(record) {
    return String(record.syncId || record.id || '');
  }

  function ensureRecordIds() {
    var changed = false;
    var deviceId = getDeviceId();

    [DB.logs, DB.trash].forEach(function (items) {
      items.forEach(function (record) {
        if (!record.syncId) {
          record.syncId =
            deviceId + ':' + String(record.id || Date.now());
          changed = true;
        }
      });
    });

    return changed;
  }

  function clone(value, fallback) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (e) {
      return fallback;
    }
  }

  function buildSnapshot() {
    return {
      version: 1,
      logs: clone(DB.logs, []),
      trash: clone(DB.trash, []),
      km: clone(DB.km, {}),
      price: clone(DB.price, {}),
      savedAt: new Date().toISOString()
    };
  }

  function validSnapshot(value) {
    return value &&
      typeof value === 'object' &&
      Array.isArray(value.logs) &&
      Array.isArray(value.trash) &&
      value.km &&
      value.price;
  }

  function mergeTrips(localLogs, localTrash, remoteLogs, remoteTrash) {
    var choices = {};

    function add(items, inTrash) {
      (Array.isArray(items) ? items : []).forEach(function (record) {
        if (!record || !recordKey(record)) return;

        var key = recordKey(record);

        var candidate = {
          record: record,
          inTrash: inTrash
        };

        var current = choices[key];

        if (
          !current ||
          timeValue(
            candidate.record.updatedAt ||
            candidate.record.createdAt
          ) >= timeValue(
            current.record.updatedAt ||
            current.record.createdAt
          )
        ) {
          choices[key] = candidate;
        }
      });
    }

    add(remoteLogs, false);
    add(remoteTrash, true);
    add(localLogs, false);
    add(localTrash, true);

    var logs = [];
    var trash = [];

    Object.keys(choices).forEach(function (key) {
      var item = choices[key];

      if (item.inTrash) {
        trash.push(item.record);
      } else {
        logs.push(item.record);
      }
    });

    return {
      logs: logs,
      trash: trash
    };
  }

  function applyRemote(snapshot, remoteUpdatedAt) {
    if (!validSnapshot(snapshot)) return false;

    var meta = readMeta();

    var localWasChangedSinceSync =
      timeValue(meta.localChangedAt) >
      timeValue(meta.lastSyncedAt);

    var merged = mergeTrips(
      DB.logs,
      DB.trash,
      snapshot.logs,
      snapshot.trash
    );

    applyingRemote = true;

    DB.logs = merged.logs;
    DB.trash = merged.trash;

    if (!localWasChangedSinceSync) {
      DB.km = clone(snapshot.km, {});
      DB.price = clone(snapshot.price, {});
    }

    var result = commit();

    applyingRemote = false;

    if (result === false) return false;

    meta.lastRemoteUpdatedAt =
      remoteUpdatedAt || meta.lastRemoteUpdatedAt;

    writeMeta(meta);

    return true;
  }

  function updateAccountUI(user) {
    var signedOut =
      document.getElementById('cloud-signed-out');

    var signedIn =
      document.getElementById('cloud-signed-in');

    var userEl =
      document.getElementById('cloud-user');

    if (signedOut) {
      signedOut.style.display =
        user ? 'none' : 'block';
    }

    if (signedIn) {
      signedIn.style.display =
        user ? 'block' : 'none';
    }

    if (userEl) {
      userEl.textContent =
        user
          ? ('已登入：' +
             (user.email || 'Supabase 使用者'))
          : '';
    }

    status(
      user
        ? '已登入，等待同步'
        : '尚未登入'
    );
  }

  function scheduleSync(delay) {
    clearTimeout(syncTimer);

    syncTimer = setTimeout(function () {
      syncNow(false);
    }, delay || 800);
  }

  async function currentUser() {
    var result = await client.auth.getUser();

    return result.data &&
      result.data.user
      ? result.data.user
      : null;
  }

  async function syncNow(showMessage) {
    if (syncing) return;

    var user;

    try {
      user = await currentUser();
    } catch (e) {
      status('無法確認登入狀態', true);
      return;
    }

    if (!user) {
      if (showMessage) {
        status('請先登入', true);
      }
      return;
    }

    syncing = true;
    status('同步中…');

    try {
      if (ensureRecordIds()) {
        applyingRemote = true;

        if (commit() === false) {
          throw new Error('本機資料無法儲存');
        }

        applyingRemote = false;
      }

      var remote =
        await client
          .from('trip_sync_state')
          .select('data, updated_at')
          .eq('user_id', user.id)
          .maybeSingle();

      if (remote.error) {
        throw remote.error;
      }

      if (
        remote.data &&
        remote.data.data
      ) {
        applyRemote(
          remote.data.data,
          remote.data.updated_at
        );
      }

      var upload =
        await client
          .from('trip_sync_state')
          .upsert(
            {
              user_id: user.id,
              data: buildSnapshot(),
              updated_at: new Date().toISOString()
            },
            {
              onConflict: 'user_id'
            }
          );

      if (upload.error) {
        throw upload.error;
      }

      var meta = readMeta();

      meta.lastSyncedAt =
        new Date().toISOString();

      writeMeta(meta);

      status('已同步');

    } catch (error) {

      status(
        '同步失敗：' +
        (error.message || '請稍後再試'),
        true
      );

    } finally {

      applyingRemote = false;
      syncing = false;
    }
  }

  async function sendOtp() {
    var input =
      document.getElementById('cloud-email');

    var email =
      input ? input.value.trim() : '';

    if (!email) {
      status('請輸入 Email', true);
      return;
    }

    status('正在寄送登入連結…');

    var options = {
      emailRedirectTo:
        'https://gamegold99.github.io/new/'
    };

    var result =
      await client.auth.signInWithOtp({
        email: email,
        options: options
      });

    if (result.error) {

      status(
        '寄送失敗：' +
        result.error.message,
        true
      );

    } else {

      status(
        '登入連結已寄出，請至 Email 開啟'
      );
    }
  }

  async function signOut() {
    var result =
      await client.auth.signOut();

    if (result.error) {
      status(
        '登出失敗：' +
        result.error.message,
        true
      );
    }
  }

  /* Existing code continues to call commit();
     this wrapper only queues cloud sync
     after a successful local save. */

  var localCommit = commit;

  commit = function () {

    var result = localCommit();

    if (
      result !== false &&
      !applyingRemote
    ) {

      var meta = readMeta();

      meta.localChangedAt =
        new Date().toISOString();

      writeMeta(meta);

      scheduleSync(1200);
    }

    return result;
  };

  /*
   * Magic Link 登入回呼處理
   *
   * Supabase PKCE 登入完成後會把 code
   * 帶回 GitHub Pages。
   *
   * 這裡明確把 code 換成 Session，
   * 避免回到網站後仍然顯示未登入。
   */

  async function handleAuthCallback() {

    var url =
      new URL(window.location.href);

    var code =
      url.searchParams.get('code');

    if (code) {

      status('正在確認登入…');

      try {

        var result =
          await client.auth.exchangeCodeForSession(
            code
          );

        if (result.error) {
          throw result.error;
        }

        /*
         * 登入成功後清除 URL 中的 code，
         * 避免重新整理時再次交換。
         */

        if (
          window.history &&
          window.history.replaceState
        ) {

          url.searchParams.delete('code');
          url.searchParams.delete('type');
          url.searchParams.delete('error');
          url.searchParams.delete('error_code');
          url.searchParams.delete(
            'error_description'
          );

          window.history.replaceState(
            {},
            document.title,
            url.pathname +
            (url.search ? url.search : '') +
            url.hash
          );
        }

      } catch (error) {

        status(
          '登入失敗：' +
          (
            error.message ||
            '無法建立登入工作階段'
          ),
          true
        );

        return false;
      }
    }

    return true;
  }

  /*
   * 監聽登入狀態
   */

  client.auth.onAuthStateChange(
    function (_event, session) {

      var user =
        session && session.user
          ? session.user
          : null;

      updateAccountUI(user);

      if (user) {
        scheduleSync(400);
      }
    }
  );

  window.addEventListener(
    'online',
    function () {
      scheduleSync(300);
    }
  );

  window.TripCloud = {
    sendOtp: sendOtp,
    signOut: signOut,
    syncNow: syncNow
  };

  /*
   * 網頁啟動：
   * 1. 處理 Magic Link code
   * 2. 取得 Session
   * 3. 更新登入畫面
   * 4. 登入後自動同步
   */

  handleAuthCallback()
    .then(function (ok) {

      if (!ok) return;

      return client.auth.getSession();
    })
    .then(function (result) {

      if (!result) return;

      if (result.error) {
        throw result.error;
      }

      var session =
        result.data &&
        result.data.session
          ? result.data.session
          : null;

      var user =
        session && session.user
          ? session.user
          : null;

      updateAccountUI(user);

      if (user) {
        scheduleSync(400);
      }
    })
    .catch(function (error) {

      status(
        '無法確認登入狀態：' +
        (
          error.message ||
          '請稍後再試'
        ),
        true
      );
    });

}());
