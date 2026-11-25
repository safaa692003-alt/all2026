/**
 * وحدة المزامنة مع قاعدة بيانات Firebase Realtime Database
 * تعمل عبر واجهة REST API القياسية بدون الحاجة لمكتبات خارجية،
 * مما يضمن عمل البرنامج محلياً بدون إنترنت والمزامنة تلقائياً عند توفر الاتصال.
 */
(function (global) {
    'use strict';

    const STORAGE_KEY = 'firebaseSyncConfig';
    const DEFAULT_CONFIG = {
        databaseURL: '',
        nodePath: 'training_system_data',
        authSecret: '',
        autoSync: true,
        lastSyncAt: ''
    };

    let cachedConfig = null;
    let pushTimer = null;
    let isPushing = false;

    function normalizeDatabaseUrl(url) {
        if (!url || typeof url !== 'string') return '';
        let cleaned = url.trim().replace(/\/+$/, '');
        if (cleaned && !/^https?:\/\//i.test(cleaned)) {
            cleaned = 'https://' + cleaned;
        }
        return cleaned;
    }

    function normalizeNodePath(nodePath) {
        if (!nodePath || typeof nodePath !== 'string') return 'training_system_data';
        const cleaned = nodePath.trim().replace(/^\/+|\/+$/g, '').replace(/\.json$/i, '');
        return cleaned || 'training_system_data';
    }

    function buildEndpoint(cfg, queryParams) {
        const base = normalizeDatabaseUrl(cfg.databaseURL);
        if (!base) return '';
        const node = normalizeNodePath(cfg.nodePath);
        const params = [];
        if (cfg.authSecret && cfg.authSecret.trim()) {
            params.push('auth=' + encodeURIComponent(cfg.authSecret.trim()));
        }
        if (queryParams) {
            params.push(queryParams);
        }
        const qs = params.length ? '?' + params.join('&') : '';
        return `${base}/${node}.json${qs}`;
    }

    function getLocalConfig() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    return Object.assign({}, DEFAULT_CONFIG, parsed);
                }
            }
        } catch (e) {}
        return Object.assign({}, DEFAULT_CONFIG);
    }

    function setLocalConfig(cfg) {
        const merged = Object.assign({}, DEFAULT_CONFIG, cfg || {});
        merged.databaseURL = normalizeDatabaseUrl(merged.databaseURL);
        merged.nodePath = normalizeNodePath(merged.nodePath);
        cachedConfig = merged;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        } catch (e) {}
        return merged;
    }

    async function loadConfig() {
        const localCfg = getLocalConfig();
        try {
            const res = await fetch('/api/firebase-config', { cache: 'no-store' });
            if (res.ok) {
                const serverCfg = await res.json();
                if (serverCfg && typeof serverCfg === 'object' && serverCfg.databaseURL) {
                    return setLocalConfig(Object.assign({}, localCfg, serverCfg));
                }
            }
        } catch (e) {}
        cachedConfig = localCfg;
        return localCfg;
    }

    async function saveConfig(cfg) {
        const normalized = setLocalConfig(cfg);
        try {
            await fetch('/api/firebase-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(normalized)
            });
        } catch (e) {
            console.warn('Could not persist firebase config to local server:', e);
        }
        return normalized;
    }

    function isConfigured(cfg) {
        const c = cfg || cachedConfig || getLocalConfig();
        return Boolean(normalizeDatabaseUrl(c.databaseURL));
    }

    async function testConnection(cfgOverride) {
        const cfg = cfgOverride ? setLocalConfig(cfgOverride) : await loadConfig();
        if (!isConfigured(cfg)) {
            return { ok: false, message: 'يرجى إدخال رابط قاعدة بيانات Firebase (Database URL) أولاً.' };
        }
        const url = buildEndpoint(cfg, 'shallow=true');
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            const res = await fetch(url, { method: 'GET', signal: controller.signal, cache: 'no-store' });
            clearTimeout(timer);

            if (res.ok) {
                return { ok: true, message: 'تم الاتصال بقاعدة بيانات Firebase بنجاح!' };
            }
            if (res.status === 401 || res.status === 403) {
                return {
                    ok: false,
                    message: 'تم رفض الوصول (401/403). تحقق من قواعد الأمان (Rules) في Firebase أو أدخل مفتاح المصادقة (Auth Secret).'
                };
            }
            if (res.status === 404) {
                return {
                    ok: false,
                    message: 'رابط قاعدة البيانات غير صحيح (404). تأكد من نسخ الرابط من Realtime Database.'
                };
            }
            return { ok: false, message: `فشل الاتصال (رمز الخطأ: ${res.status})` };
        } catch (err) {
            if (err && err.name === 'AbortError') {
                return { ok: false, message: 'انتهت مهلة الاتصال. تحقق من اتصال الإنترنت.' };
            }
            return { ok: false, message: 'تعذر الاتصال بـ Firebase: ' + (err.message || err) };
        }
    }

    async function pushData(payload, cfgOverride) {
        const cfg = cfgOverride || cachedConfig || await loadConfig();
        if (!isConfigured(cfg)) {
            return { ok: false, skipped: true, message: 'Firebase غير مهيأ.' };
        }
        if (isPushing) {
            return { ok: false, skipped: true, message: 'توجد عملية مزامنة قيد التنفيذ.' };
        }

        const url = buildEndpoint(cfg);
        isPushing = true;
        try {
            const cleanPayload = Object.assign({}, payload || {});
            delete cleanPayload.allowEmptyOverwrite;
            if (!cleanPayload.lastUpdated) {
                cleanPayload.lastUpdated = new Date().toISOString();
            }

            const res = await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cleanPayload)
            });

            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return { ok: false, message: `فشل الرفع إلى Firebase (${res.status}): ${text}` };
            }

            cfg.lastSyncAt = new Date().toISOString();
            setLocalConfig(cfg);
            try {
                window.dispatchEvent(new CustomEvent('firebase-sync-updated', { detail: { direction: 'push', cfg } }));
            } catch (e) {}
            return { ok: true, message: 'تم رفع البيانات ومزامنتها مع Firebase بنجاح.', lastSyncAt: cfg.lastSyncAt };
        } catch (err) {
            return { ok: false, message: 'تعذر الرفع إلى Firebase: ' + (err.message || err) };
        } finally {
            isPushing = false;
        }
    }

    async function pullData(cfgOverride) {
        const cfg = cfgOverride || cachedConfig || await loadConfig();
        if (!isConfigured(cfg)) {
            return { ok: false, skipped: true, message: 'Firebase غير مهيأ.' };
        }

        const url = buildEndpoint(cfg);
        try {
            const res = await fetch(url, { method: 'GET', cache: 'no-store' });
            if (!res.ok) {
                return { ok: false, message: `فشل سحب البيانات من Firebase (${res.status})` };
            }
            const data = await res.json();
            if (!data || typeof data !== 'object') {
                return { ok: true, empty: true, data: null, message: 'لا توجد بيانات محفوظة في Firebase بعد.' };
            }
            cfg.lastSyncAt = new Date().toISOString();
            setLocalConfig(cfg);
            try {
                window.dispatchEvent(new CustomEvent('firebase-sync-updated', { detail: { direction: 'pull', cfg } }));
            } catch (e) {}
            return { ok: true, empty: false, data, message: 'تم جلب البيانات من Firebase بنجاح.' };
        } catch (err) {
            return { ok: false, message: 'تعذر جلب البيانات من Firebase: ' + (err.message || err) };
        }
    }

    function scheduleAutoPush(getPayloadFn, delayMs) {
        const cfg = cachedConfig || getLocalConfig();
        if (!isConfigured(cfg) || !cfg.autoSync) return;

        if (pushTimer) clearTimeout(pushTimer);
        pushTimer = setTimeout(async () => {
            try {
                const payload = typeof getPayloadFn === 'function' ? getPayloadFn() : getPayloadFn;
                if (payload && typeof payload === 'object') {
                    await pushData(payload, cfg);
                }
            } catch (e) {
                console.warn('Firebase auto-push error:', e);
            }
        }, typeof delayMs === 'number' ? delayMs : 1500);
    }

    function hasAnyRecords(d) {
        if (!d || typeof d !== 'object') return false;
        const keys = [
            'statisticsData',
            'traineesData',
            'leadersData',
            'savedAdminOrders',
            'incomingData',
            'outgoingData',
            'totalReportData',
            'lecturerPaymentsData'
        ];
        return keys.some(k => Array.isArray(d[k]) && d[k].length > 0);
    }

    async function autoPullOnStartup(localPayload, onApplyRemote) {
        const cfg = await loadConfig();
        if (!isConfigured(cfg) || !cfg.autoSync) return { ok: false, skipped: true };

        const result = await pullData(cfg);
        if (!result.ok || result.empty || !result.data) {
            // إذا كانت السحابة فارغة والمحلي يحتوي على بيانات، نرفع البيانات المحلية تلقائياً
            if (result.ok && result.empty && hasAnyRecords(localPayload)) {
                await pushData(localPayload, cfg);
            }
            return result;
        }

        const remoteData = result.data;
        const remoteTime = Date.parse(remoteData.lastUpdated || '') || 0;
        const localTime = Date.parse((localPayload && localPayload.lastUpdated) || '') || 0;
        const localHasData = hasAnyRecords(localPayload);
        const remoteHasData = hasAnyRecords(remoteData);

        if (remoteHasData && (!localHasData || remoteTime > localTime)) {
            if (typeof onApplyRemote === 'function') {
                onApplyRemote(remoteData);
            }
            return { ok: true, applied: true, data: remoteData };
        } else if (localHasData && localTime > remoteTime) {
            await pushData(localPayload, cfg);
        }
        return { ok: true, applied: false, data: remoteData };
    }

    global.FirebaseSync = {
        loadConfig,
        saveConfig,
        getLocalConfig,
        isConfigured,
        testConnection,
        pushData,
        pullData,
        scheduleAutoPush,
        autoPullOnStartup
    };
})(window);
