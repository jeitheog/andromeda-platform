// ── State ──────────────────────────────────────────────────
const state = {
    metaConnected: false,
    briefing: null,
    concepts: [],        // [{angle,hook,headline,body,cta,painPoint,targetEmotion,imageB64,selected}]
    campaigns: [],       // [{id, name, adSetIds, adIds, platform}] saved in localStorage
    pendingOptimizations: null,
    selectedProduct: null, // {id, title, price, description, image, tags, type}
    research: {
        competitor: '',
        adsCount: 0,
        funnelCount: 0,
        ads: [],
        report: ''
    }
};

const STORAGE_KEY = 'andromeda_state_v1';
function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ briefing: state.briefing, concepts: state.concepts, campaigns: state.campaigns })); }
    catch (e) { console.warn('saveState error:', e); }
}
function loadState() {
    try {
        const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (!s) return;
        if (s.briefing) state.briefing = s.briefing;
        if (s.concepts) state.concepts = s.concepts;
        if (s.campaigns) state.campaigns = s.campaigns;
    } catch (e) { console.warn('loadState error:', e); }
}

// ── DOM helpers ────────────────────────────────────────────
const $ = id => document.getElementById(id);
const sanitizeHeader = v => (v || '').replace(/[^\x20-\x7E]/g, '');
const metaHeaders = () => {
    const token = sanitizeHeader($('metaToken')?.value?.trim() || localStorage.getItem('meta_token') || '');
    const account = sanitizeHeader($('metaAdAccount')?.value?.trim() || localStorage.getItem('meta_account') || '');
    const pageId = sanitizeHeader($('metaPageId')?.value?.trim() || localStorage.getItem('meta_page') || '');
    const libraryToken = sanitizeHeader($('metaLibraryToken')?.value?.trim() || localStorage.getItem('meta_library_token') || '');
    return { 'x-meta-token': token, 'x-meta-account': account, 'x-meta-page': pageId, 'x-meta-library-token': libraryToken, 'Content-Type': 'application/json' };
};
const googleHeaders = () => ({
    'x-google-token': localStorage.getItem('google_token') || '',
    'x-google-customer': localStorage.getItem('google_customer') || '',
    'x-google-dev-token': localStorage.getItem('google_dev_token') || '',
    'Content-Type': 'application/json'
});
const tiktokHeaders = () => ({
    'x-tiktok-token': localStorage.getItem('tiktok_token') || '',
    'x-tiktok-advertiser': localStorage.getItem('tiktok_advertiser') || '',
    'Content-Type': 'application/json'
});
const aiHeaders = () => {
    const h = { 'Content-Type': 'application/json' };
    const anth = localStorage.getItem('anthropic_key');
    const oai = localStorage.getItem('openai_key');
    if (anth) h['x-anthropic-key'] = sanitizeHeader(anth);
    if (oai) h['x-openai-key'] = sanitizeHeader(oai);
    return h;
};

function showStatus(elId, msg, type = 'info') {
    const el = $(elId);
    if (!el) return;
    el.textContent = msg;
    el.className = `status-msg ${type}`;
    el.classList.remove('hidden');
}
function hideStatus(elId) { $(elId)?.classList.add('hidden'); }

// ── Meta token expiry ───────────────────────────────────────
function showMetaTokenExpiredBanner() {
    if (document.getElementById('metaTokenExpiredBanner')) return; // already shown
    const banner = document.createElement('div');
    banner.id = 'metaTokenExpiredBanner';
    banner.className = 'meta-expired-banner';
    banner.innerHTML = `
        <div class="meta-expired-content">
            <span>🔑 Tu token de Meta ha expirado. Obtén uno nuevo en Graph API Explorer y actualízalo en Configuración.</span>
            <button class="btn btn-primary btn-sm" onclick="window.goToMetaTokenSetup()">Renovar token →</button>
            <button class="meta-expired-close" onclick="document.getElementById('metaTokenExpiredBanner').remove()">✕</button>
        </div>
    `;
    document.querySelector('.sidebar + .main-content, main, .content, body')?.prepend(banner)
        || document.body.appendChild(banner);
}

window.goToMetaTokenSetup = function () {
    document.getElementById('metaTokenExpiredBanner')?.remove();
    switchView('setup');
    setTimeout(() => { openMetaPanel?.(); $('metaToken')?.focus(); }, 150);
};

function checkTokenExpired(data) {
    if (data?.tokenExpired) { showMetaTokenExpiredBanner(); return true; }
    return false;
}

function showLoader(msg = 'Procesando...') {
    let el = document.getElementById('loaderOverlay');
    if (!el) {
        el = document.createElement('div');
        el.id = 'loaderOverlay';
        el.className = 'loader-overlay';
        el.innerHTML = `<div class="loader-spinner"></div><p id="loaderMsg">${msg}</p>`;
        document.body.appendChild(el);
    } else {
        document.getElementById('loaderMsg').textContent = msg;
        el.classList.remove('hidden');
    }
    setAgentStatus('thinking', msg);
}
function hideLoader() {
    document.getElementById('loaderOverlay')?.classList.add('hidden');
    setAgentStatus('idle');
}

function setAgentStatus(state, label = '') {
    const dot = $('agentDot');
    const lbl = $('agentLabel');
    dot.className = 'agent-dot' + (state === 'thinking' ? ' thinking' : state === 'active' ? ' active' : '');
    lbl.textContent = label || (state === 'thinking' ? 'Agente trabajando...' : 'Agentes listos');
}

// ── View routing ───────────────────────────────────────────
function switchView(view) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const viewEl = document.getElementById('view' + view.charAt(0).toUpperCase() + view.slice(1));
    if (viewEl) viewEl.classList.add('active');
    document.querySelector(`[data-view="${view}"]`)?.classList.add('active');
}

// ── Initialization ─────────────────────────────────────────
function init() {
    loadState();
    restoreCredentials();

    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const view = btn.dataset.view;
            switchView(view);
            if (view === 'concepts' && state.concepts.length > 0) renderConcepts();
            if (view === 'campaign') { renderSelectedSummary(); updateLaunchBtn(); }
            if (view === 'dashboard') populateCampaignSelector();
        });
    });

    // AI Keys
    $('btnSaveApiKeys').addEventListener('click', saveApiKeys);

    // Setup — platform cards
    $('platformMeta').addEventListener('click', toggleMetaPanel);
    $('btnOpenMeta').addEventListener('click', e => { e.stopPropagation(); openMetaPanel(); });
    $('btnCloseMetaPanel').addEventListener('click', closeMetaPanel);
    $('btnVerifyMeta').addEventListener('click', verifyMeta);

    $('platformGoogle').addEventListener('click', toggleGooglePanel);
    $('btnOpenGoogle').addEventListener('click', e => { e.stopPropagation(); openGooglePanel(); });
    $('btnCloseGooglePanel').addEventListener('click', closeGooglePanel);
    $('btnVerifyGoogle').addEventListener('click', verifyGoogle);

    $('platformTikTok').addEventListener('click', toggleTikTokPanel);
    $('btnOpenTikTok').addEventListener('click', e => { e.stopPropagation(); openTikTokPanel(); });
    $('btnCloseTikTokPanel').addEventListener('click', closeTikTokPanel);
    $('btnVerifyTikTok').addEventListener('click', verifyTikTok);

    $('platformMetaLibrary').addEventListener('click', toggleMetaLibraryPanel);
    $('btnOpenMetaLibrary').addEventListener('click', e => { e.stopPropagation(); openMetaLibraryPanel(); });
    $('btnCloseMetaLibraryPanel').addEventListener('click', closeMetaLibraryPanel);
    $('btnSaveMetaLibrary').addEventListener('click', saveMetaLibraryToken);

    $('btnImportFromShopify').addEventListener('click', importFromShopify);

    // Campaign platform tabs
    document.querySelectorAll('.camp-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.camp-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            $('activePlatform').value = tab.dataset.platform;
        });
    });

    // Restore saved Shopify inputs
    const savedShop = localStorage.getItem('andromeda_shopify_shop');
    const savedToken = localStorage.getItem('andromeda_shopify_token');
    if (savedShop) $('shopifyShopUrl').value = savedShop;
    if (savedToken) $('shopifyTokenInput').value = savedToken;

    // Briefing — product picker
    $('btnLoadProducts').addEventListener('click', loadShopifyProducts);
    $('productSearchInput').addEventListener('input', () => renderProductList($('productSearchInput').value));
    $('btnClearSearch').addEventListener('click', () => { $('productSearchInput').value = ''; renderProductList(''); $('productSearchInput').focus(); });
    $('btnClearProduct').addEventListener('click', clearSelectedProduct);

    // Briefing
    document.querySelectorAll('.tone-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tone-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            $('b5').value = btn.dataset.tone;
        });
    });
    $('btnGenerateConcepts').addEventListener('click', generateConcepts);
    $('btnSaveStrategy').addEventListener('click', openSaveStrategyModal);
    $('btnConfirmSaveStrategy').addEventListener('click', confirmSaveStrategy);
    $('btnCancelStrategy').addEventListener('click', () => $('saveStrategyModal').classList.add('hidden'));
    $('saveStrategyModal').addEventListener('click', e => { if (e.target === $('saveStrategyModal')) $('saveStrategyModal').classList.add('hidden'); });
    $('strategyNameInput').addEventListener('keydown', e => { if (e.key === 'Enter') confirmSaveStrategy(); });

    // Concepts
    $('btnSelectAllConcepts').addEventListener('click', toggleSelectAllConcepts);
    $('btnGoToCampaign').addEventListener('click', () => {
        renderSelectedSummary();
        switchView('campaign');
    });

    // Creative modal
    $('btnCloseModal').addEventListener('click', closeModal);
    $('modal-backdrop') && document.querySelector('.modal-backdrop').addEventListener('click', closeModal);
    document.querySelectorAll('.modal-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            ['modeGenerate', 'modeShopify', 'modeEdit', 'modeManual'].forEach(id => $(id)?.classList.add('hidden'));
            const modeMap = { generate: 'modeGenerate', shopify: 'modeShopify', edit: 'modeEdit', manual: 'modeManual' };
            $(modeMap[tab.dataset.mode])?.classList.remove('hidden');
        });
    });
    $('btnGenerateCreative').addEventListener('click', generateCreative);
    setupFileUpload('photoUploadArea', 'photoFileInput', 'photoPreview');
    setupFileUpload('manualUploadArea', 'manualFileInput', 'manualPreview');

    // Campaign
    $('dailyBudget').addEventListener('input', updateBudgetHint);
    $('campaignDuration').addEventListener('input', updateBudgetHint);
    $('btnLaunchCampaign').addEventListener('click', launchCampaign);

    // Real-time validation: clear error state as user types
    ['campaignName', 'destinationUrl', 'targetCountries'].forEach(id => {
        $(id)?.addEventListener('input', () => {
            $(id).classList.toggle('field-error', !$(id).value.trim());
            updateLaunchBtn();
        });
    });

    // Dashboard
    $('btnRefreshStats').addEventListener('click', refreshStats);
    $('btnAnalyzeAI').addEventListener('click', analyzeWithAI);
    $('btnApplyOptimizations').addEventListener('click', applyOptimizations);
    $('campaignSelector').addEventListener('change', () => { refreshStats(); checkPendingUploads(); });
    $('btnUploadPending')?.addEventListener('click', uploadToExistingCampaign);

    // Restore UI
    if (state.concepts.length > 0) {
        $('badgeConcepts').textContent = state.concepts.length;
        $('badgeConcepts').classList.add('visible');
    }
    if (state.campaigns.length > 0) {
        $('badgeDashboard').classList.add('visible');
    }

    setCampaignName();

    // Research - Internal Tabs
    document.querySelectorAll('.research-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const view = tab.dataset.resView;
            document.querySelectorAll('.research-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            $('resAdsGrid').classList.toggle('hidden', view !== 'ads-grid');
            $('resStrategyReport').classList.toggle('hidden', view !== 'strategy-report');
        });
    });

    $('btnStartResearch')?.addEventListener('click', startResearch);

    // Brand URL Analyzer
    $('btnAnalyzeBrandUrl')?.addEventListener('click', analyzeBrandUrl);
    $('brandUrlInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') analyzeBrandUrl(); });

    // Funnel filter tabs
    document.querySelectorAll('.funnel-tab').forEach(tab => {
        tab.addEventListener('click', () => filterConceptsByFunnel(tab.dataset.funnel));
    });

    // Full strategy button
    $('btnFullStrategy')?.addEventListener('click', generateFullStrategy);

    // Script modal
    $('btnCloseScriptModal')?.addEventListener('click', () => $('modal-script').classList.add('hidden'));
    $('btnCloseScriptModalBottom')?.addEventListener('click', () => $('modal-script').classList.add('hidden'));
    $('btnCopyScript')?.addEventListener('click', () => {
        const txt = $('scriptContent')?.textContent || '';
        navigator.clipboard.writeText(txt).then(() => showToast('Script copiado al portapapeles'));
    });
    $('btnRegenerateScript')?.addEventListener('click', _generateScript);
    document.querySelectorAll('.script-dur-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            _scriptDuration = +tab.dataset.dur;
            document.querySelectorAll('.script-dur-tab').forEach(t => t.classList.toggle('active', t === tab));
            _generateScript();
        });
    });

    // Landing modal
    $('btnCloseLandingModal')?.addEventListener('click', () => $('modal-landing').classList.add('hidden'));
    $('btnCloseLandingModalBottom')?.addEventListener('click', () => $('modal-landing').classList.add('hidden'));
    $('btnDownloadLanding')?.addEventListener('click', () => {
        if (_landingHtml) downloadHtml(_landingHtml, 'landing-page.html');
        else showToast('Genera primero la landing page');
    });
    $('btnRegenerateLanding')?.addEventListener('click', _generateLanding);
    document.querySelectorAll('.landing-type-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            _landingPageType = tab.dataset.type;
            document.querySelectorAll('.landing-type-tab').forEach(t => t.classList.toggle('active', t === tab));
            _generateLanding();
        });
    });

    // Strategy modal
    $('btnCloseStrategyModal')?.addEventListener('click', () => $('modal-strategy').classList.add('hidden'));
    $('btnCloseStrategyModalBottom')?.addEventListener('click', () => $('modal-strategy').classList.add('hidden'));
    document.querySelectorAll('.strategy-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            _strategyStage = tab.dataset.stage;
            document.querySelectorAll('.strategy-tab').forEach(t => t.classList.toggle('active', t === tab));
            renderStrategyContent(_strategyStage);
        });
    });

    console.log('Andromeda Ads Initialized');
}

// ── Platform panel helpers ──────────────────────────────────
function openMetaPanel() {
    $('metaFormPanel').classList.add('open');
    $('platformMeta').classList.add('active');
}
function closeMetaPanel() {
    $('metaFormPanel').classList.remove('open');
    $('platformMeta').classList.remove('active');
}
function toggleMetaPanel() {
    $('metaFormPanel').classList.contains('open') ? closeMetaPanel() : openMetaPanel();
}

function setMetaBadge(connected) {
    const badge = $('metaBadge');
    if (!badge) return;
    if (connected) {
        badge.className = 'platform-status-badge connected';
        badge.innerHTML = '<span class="status-dot"></span><span class="status-text">Conectado</span>';
        $('btnOpenMeta').textContent = 'Editar →';
    } else {
        badge.className = 'platform-status-badge';
        badge.innerHTML = '<span class="status-dot"></span><span class="status-text">Sin conectar</span>';
        $('btnOpenMeta').textContent = 'Configurar →';
    }
}

// Google panel
function openGooglePanel() { $('googleFormPanel').classList.add('open'); $('platformGoogle').classList.add('active'); closeTikTokPanel(); closeMetaPanel(); }
function closeGooglePanel() { $('googleFormPanel').classList.remove('open'); $('platformGoogle').classList.remove('active'); }
function toggleGooglePanel() { $('googleFormPanel').classList.contains('open') ? closeGooglePanel() : openGooglePanel(); }

function setGoogleBadge(connected) {
    const badge = $('googleBadge');
    if (!badge) return;
    badge.className = connected ? 'platform-status-badge connected' : 'platform-status-badge';
    badge.innerHTML = `<span class="status-dot"></span><span class="status-text">${connected ? 'Conectado' : 'Sin conectar'}</span>`;
    $('btnOpenGoogle').textContent = connected ? 'Editar →' : 'Configurar →';
}

// TikTok panel
function openTikTokPanel() { $('tiktokFormPanel').classList.add('open'); $('platformTikTok').classList.add('active'); closeGooglePanel(); closeMetaPanel(); }
function closeTikTokPanel() { $('tiktokFormPanel').classList.remove('open'); $('platformTikTok').classList.remove('active'); }
function toggleTikTokPanel() { $('tiktokFormPanel').classList.contains('open') ? closeTikTokPanel() : openTikTokPanel(); }

function openMetaLibraryPanel() { $('metaLibraryFormPanel').classList.add('open'); $('platformMetaLibrary').classList.add('active'); closeGooglePanel(); closeMetaPanel(); closeTikTokPanel(); }
function closeMetaLibraryPanel() { $('metaLibraryFormPanel').classList.remove('open'); $('platformMetaLibrary').classList.remove('active'); }
function toggleMetaLibraryPanel() { $('metaLibraryFormPanel').classList.contains('open') ? closeMetaLibraryPanel() : openMetaLibraryPanel(); }

function setMetaLibraryBadge(connected) {
    const badge = $('metaLibraryBadge');
    if (!badge) return;
    badge.className = connected ? 'platform-status-badge connected' : 'platform-status-badge';
    badge.innerHTML = `<span class="status-dot"></span><span class="status-text">${connected ? 'Conectado' : 'Sin conectar'}</span>`;
    $('btnOpenMetaLibrary').textContent = connected ? 'Editar →' : 'Configurar →';
}

function saveMetaLibraryToken() {
    const token = $('metaLibraryToken').value.trim();
    if (!token) { showStatus('metaLibraryStatus', 'Introduce el token de acceso', 'error'); return; }
    localStorage.setItem('meta_library_token', token);
    setMetaLibraryBadge(true);
    showStatus('metaLibraryStatus', '✅ Token guardado', 'success');
    setTimeout(closeMetaLibraryPanel, 1000);
}

function setTikTokBadge(connected) {
    const badge = $('tiktokBadge');
    if (!badge) return;
    badge.className = connected ? 'platform-status-badge connected' : 'platform-status-badge';
    badge.innerHTML = `<span class="status-dot"></span><span class="status-text">${connected ? 'Conectado' : 'Sin conectar'}</span>`;
    $('btnOpenTikTok').textContent = connected ? 'Editar →' : 'Configurar →';
}

function restoreCredentials() {
    // Meta
    const metaToken = localStorage.getItem('meta_token');
    const metaAccount = localStorage.getItem('meta_account');
    const metaPage = localStorage.getItem('meta_page');
    if (metaToken) $('metaToken').value = metaToken;
    if (metaAccount) $('metaAdAccount').value = metaAccount;
    if (metaPage) $('metaPageId').value = metaPage;
    if (metaToken && metaAccount) {
        state.metaConnected = true;
        setMetaBadge(true);
        showStatus('metaStatus', '✅ Credenciales guardadas', 'success');
        $('badgeSetup').textContent = '✓';
        $('badgeSetup').classList.add('visible');
    }

    // Google
    const gToken = localStorage.getItem('google_token');
    const gCustomer = localStorage.getItem('google_customer');
    const gDevToken = localStorage.getItem('google_dev_token');
    if (gToken) $('googleAccessToken').value = gToken;
    if (gCustomer) $('googleCustomerId').value = gCustomer;
    if (gDevToken) $('googleDevToken').value = gDevToken;
    if (gToken && gCustomer) {
        setGoogleBadge(true);
        showStatus('googleStatus', '✅ Credenciales guardadas', 'success');
    }

    // TikTok
    const ttToken = localStorage.getItem('tiktok_token');
    const ttAdv = localStorage.getItem('tiktok_advertiser');
    if (ttToken) $('tiktokAccessToken').value = ttToken;
    if (ttAdv) $('tiktokAdvertiserId').value = ttAdv;
    if (ttToken && ttAdv) {
        setTikTokBadge(true);
        showStatus('tiktokStatus', '✅ Credenciales guardadas', 'success');
    }

    // Meta Ad Library
    const libToken = localStorage.getItem('meta_library_token');
    if (libToken) { $('metaLibraryToken').value = libToken; setMetaLibraryBadge(true); showStatus('metaLibraryStatus', '✅ Token guardado', 'success'); }

    // AI Keys
    const anthropicKey = localStorage.getItem('anthropic_key');
    const openaiKey = localStorage.getItem('openai_key');
    if (anthropicKey) $('anthropicKeyInput').value = anthropicKey;
    if (openaiKey) $('openaiKeyInput').value = openaiKey;
    updateAiKeyBadges();
}

function updateAiKeyBadges() {
    const anthBadge = $('claudeKeyBadge');
    const oaiBadge = $('openaiKeyBadge');
    const hasAnth = !!(localStorage.getItem('anthropic_key'));
    const hasOai = !!(localStorage.getItem('openai_key'));
    if (anthBadge) {
        anthBadge.textContent = hasAnth ? '✓ Configurada' : 'Sin clave';
        anthBadge.classList.toggle('configured', hasAnth);
    }
    if (oaiBadge) {
        oaiBadge.textContent = hasOai ? '✓ Configurada' : 'Sin clave';
        oaiBadge.classList.toggle('configured', hasOai);
    }
}

function saveApiKeys() {
    const anthKey = $('anthropicKeyInput').value.trim();
    const oaiKey = $('openaiKeyInput').value.trim();
    if (anthKey) localStorage.setItem('anthropic_key', anthKey);
    else localStorage.removeItem('anthropic_key');
    if (oaiKey) localStorage.setItem('openai_key', oaiKey);
    else localStorage.removeItem('openai_key');
    updateAiKeyBadges();
    showStatus('apiKeysStatus', '✅ Claves guardadas en el navegador', 'success');
    setTimeout(() => hideStatus('apiKeysStatus'), 3000);
}

// ── Copy Strategies ─────────────────────────────────────────
const STRATEGIES_KEY = 'andromeda_strategies';

function readBriefingForm() {
    return {
        product: $('b1').value.trim(),
        audience: $('b2').value.trim(),
        painPoint: $('b3').value.trim(),
        differentiator: $('b4').value.trim(),
        tone: $('b5').value.trim()
    };
}

function loadStrategies() {
    try { return JSON.parse(localStorage.getItem(STRATEGIES_KEY) || '[]'); }
    catch { return []; }
}

function persistStrategies(list) {
    localStorage.setItem(STRATEGIES_KEY, JSON.stringify(list));
}

function openSaveStrategyModal() {
    const b = readBriefingForm();
    if (!b.product && !b.audience && !b.painPoint && !b.differentiator) {
        showStatus('briefingStatus', '⚠️ Rellena al menos un campo del briefing antes de guardar', 'warning');
        setTimeout(() => hideStatus('briefingStatus'), 3000);
        return;
    }
    $('strategyNameInput').value = '';
    $('saveStrategyModal').classList.remove('hidden');
    setTimeout(() => $('strategyNameInput').focus(), 100);
}

function confirmSaveStrategy() {
    const name = $('strategyNameInput').value.trim();
    if (!name) { $('strategyNameInput').focus(); return; }
    const b = readBriefingForm();
    const list = loadStrategies();
    list.unshift({
        id: Date.now(),
        name,
        briefing: b,
        createdAt: new Date().toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' })
    });
    persistStrategies(list);
    $('saveStrategyModal').classList.add('hidden');
    renderStrategies();
    showStatus('briefingStatus', `✅ Estrategia "${name}" guardada`, 'success');
    setTimeout(() => hideStatus('briefingStatus'), 3000);
}

function renderStrategies() {
    const list = loadStrategies();
    const container = $('strategiesList');
    const counter = $('strategiesCount');
    counter.textContent = `${list.length} guardada${list.length !== 1 ? 's' : ''}`;

    if (!list.length) {
        container.innerHTML = `<p class="strategies-empty">Aún no hay estrategias guardadas. Rellena el briefing y pulsa <strong>Guardar estrategia</strong>.</p>`;
        return;
    }

    const toneEmoji = { 'elegante y sofisticada': '✨', 'casual y cercana': '😊', 'atrevida y provocadora': '🔥', 'minimalista y clean': '🤍', 'divertida y jovial': '🎉', 'empoderada y feminista': '💪' };

    container.innerHTML = list.map(s => `
        <div class="strategy-card" data-id="${s.id}">
            <div class="strategy-info">
                <div class="strategy-name">${s.name}</div>
                <div class="strategy-meta">
                    ${s.briefing.tone ? `<span class="strategy-tone">${toneEmoji[s.briefing.tone] || ''} ${s.briefing.tone}</span>` : ''}
                    <span class="strategy-date">${s.createdAt}</span>
                </div>
                ${s.briefing.product ? `<div class="strategy-preview">${s.briefing.product}</div>` : ''}
            </div>
            <div class="strategy-actions">
                <button class="btn-load-strategy" onclick="window.loadStrategy(${s.id})">↩ Cargar</button>
                <button class="btn-delete-strategy" onclick="window.deleteStrategy(${s.id})" title="Eliminar">🗑</button>
            </div>
        </div>
    `).join('');
}

window.loadStrategy = function (id) {
    const list = loadStrategies();
    const s = list.find(x => x.id === id);
    if (!s) return;
    const b = s.briefing;
    $('b1').value = b.product || '';
    $('b2').value = b.audience || '';
    $('b3').value = b.painPoint || '';
    $('b4').value = b.differentiator || '';
    $('b5').value = b.tone || '';
    document.querySelectorAll('.tone-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tone === b.tone);
    });
    showStatus('briefingStatus', `✅ Estrategia "${s.name}" cargada`, 'success');
    setTimeout(() => hideStatus('briefingStatus'), 3000);
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.deleteStrategy = function (id) {
    const list = loadStrategies().filter(x => x.id !== id);
    persistStrategies(list);
    renderStrategies();
};

function setCampaignName() {
    const now = new Date();
    const mon = now.toLocaleString('es', { month: 'short' }).toUpperCase();
    $('campaignName').value = `Andromeda_Moda_${mon}${now.getFullYear()}`;
    updateLaunchBtn();
}

// ── Campaign form validation ────────────────────────────────
const REQUIRED_CAMPAIGN_FIELDS = [
    { id: 'campaignName', label: 'Nombre de campaña' },
    { id: 'destinationUrl', label: 'URL de destino' },
    { id: 'targetCountries', label: 'País(es)' }
];

function validateCampaignFields() {
    const errors = [];
    REQUIRED_CAMPAIGN_FIELDS.forEach(({ id, label }) => {
        const el = $(id);
        const empty = !el?.value?.trim();
        el?.classList.toggle('field-error', empty);
        if (empty) errors.push(label);
    });

    // Page ID is stored in Setup, critical for Meta ads
    const platform = $('activePlatform')?.value || 'meta';
    if (platform === 'meta') {
        const pageId = $('metaPageId')?.value?.trim() || localStorage.getItem('meta_page') || '';
        if (!pageId) errors.push('Facebook Page ID (Configuración → Meta)');
    }

    return errors;
}

function updateLaunchBtn() {
    const errors = validateCampaignFields();
    const btn = $('btnLaunchCampaign');
    if (!btn) return;
    btn.disabled = errors.length > 0;
    btn.title = errors.length ? `Faltan: ${errors.join(', ')}` : '';
}

// ── Setup / Shopify brand import ───────────────────────────
async function importFromShopify() {
    const shop = $('shopifyShopUrl').value.trim();
    const token = $('shopifyTokenInput').value.trim();
    if (!shop || !token) {
        showStatus('shopifyImportStatus', 'Introduce la URL de la tienda y el token de acceso', 'error');
        return;
    }

    $('btnImportFromShopify').disabled = true;
    $('btnImportFromShopify').innerHTML = '<span class="spinner-inline"></span>Analizando con IA...';
    hideStatus('shopifyImportStatus');
    showLoader('Analizando tu tienda de Shopify con IA...');

    try {
        const res = await fetch('/api/shopify-analyze', {
            method: 'POST',
            headers: {
                'x-shopify-shop': shop,
                'x-shopify-token': token,
                'Content-Type': 'application/json'
            }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        const p = data.brandProfile;

        // Auto-fill briefing fields
        if ($('b1')) $('b1').value = p.product || '';
        if ($('b2')) $('b2').value = p.audience || '';
        if ($('b3')) $('b3').value = p.painPoint || '';
        if ($('b4')) $('b4').value = p.differentiator || '';

        // Select matching tone button
        if (p.tone) {
            document.querySelectorAll('.tone-btn').forEach(btn => {
                if (btn.dataset.tone && p.tone.toLowerCase().includes(btn.dataset.tone.toLowerCase())) {
                    btn.click();
                }
            });
        }

        // Persist credentials
        localStorage.setItem('andromeda_shopify_shop', shop);
        localStorage.setItem('andromeda_shopify_token', token);

        hideLoader();
        showStatus('shopifyImportStatus',
            `✅ Marca importada: ${data.storeName} (${data.productCount} productos analizados)`,
            'success'
        );

        // Navigate to briefing after short delay
        setTimeout(() => switchView('briefing'), 1500);

    } catch (err) {
        hideLoader();
        showStatus('shopifyImportStatus', `❌ ${err.message}`, 'error');
    } finally {
        $('btnImportFromShopify').disabled = false;
        $('btnImportFromShopify').innerHTML = '✨ Analizar tienda con IA';
    }
}

// ── Setup / Meta validation ────────────────────────────────
async function verifyMeta() {
    const token = $('metaToken').value.trim();
    const account = $('metaAdAccount').value.trim();
    const page = $('metaPageId').value.trim();
    if (!token || !account) { showStatus('metaStatus', 'Introduce el token y el Ad Account ID', 'error'); return; }

    $('btnVerifyMeta').disabled = true;
    $('btnVerifyMeta').innerHTML = '<span class="spinner-inline"></span>Verificando...';
    hideStatus('metaStatus');

    try {
        const res = await fetch('/api/meta-validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, adAccountId: account, pageId: page })
        });
        const data = await res.json();
        if (data.tokenExpired) {
            showStatus('metaStatus', '❌ Token expirado. Genera uno nuevo en Graph API Explorer.', 'error');
            return;
        }
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        localStorage.setItem('meta_token', token);
        localStorage.setItem('meta_account', account);
        if (page) localStorage.setItem('meta_page', page);

        state.metaConnected = true;
        setMetaBadge(true);
        showStatus('metaStatus', `✅ Conectado: ${data.accountName} (${account})`, 'success');
        $('badgeSetup').textContent = '✓';
        $('badgeSetup').classList.add('visible');
        setAgentStatus('active', 'Meta conectado');
        setTimeout(closeMetaPanel, 1200);
    } catch (err) {
        showStatus('metaStatus', `❌ ${err.message}`, 'error');
    } finally {
        $('btnVerifyMeta').disabled = false;
        $('btnVerifyMeta').textContent = '🔗 Verificar Conexión';
    }
}

async function verifyGoogle() {
    const customerId = $('googleCustomerId').value.trim();
    const developerToken = $('googleDevToken').value.trim();
    const accessToken = $('googleAccessToken').value.trim();
    if (!customerId || !developerToken || !accessToken) {
        showStatus('googleStatus', 'Introduce los 3 campos de Google Ads', 'error'); return;
    }
    $('btnVerifyGoogle').disabled = true;
    $('btnVerifyGoogle').innerHTML = '<span class="spinner-inline"></span>Verificando...';
    hideStatus('googleStatus');
    try {
        const res = await fetch('/api/google-validate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ customerId, developerToken, accessToken })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        localStorage.setItem('google_token', accessToken);
        localStorage.setItem('google_customer', customerId.replace(/-/g, ''));
        localStorage.setItem('google_dev_token', developerToken);
        setGoogleBadge(true);
        showStatus('googleStatus', `✅ Conectado: ${data.accountName}`, 'success');
        $('badgeSetup').textContent = '✓'; $('badgeSetup').classList.add('visible');
        setTimeout(closeGooglePanel, 1200);
    } catch (err) {
        showStatus('googleStatus', `❌ ${err.message}`, 'error');
    } finally {
        $('btnVerifyGoogle').disabled = false;
        $('btnVerifyGoogle').textContent = '🔗 Verificar Conexión';
    }
}

async function verifyTikTok() {
    const accessToken = $('tiktokAccessToken').value.trim();
    const advertiserId = $('tiktokAdvertiserId').value.trim();
    if (!accessToken || !advertiserId) {
        showStatus('tiktokStatus', 'Introduce el Access Token y el Advertiser ID', 'error'); return;
    }
    $('btnVerifyTikTok').disabled = true;
    $('btnVerifyTikTok').innerHTML = '<span class="spinner-inline"></span>Verificando...';
    hideStatus('tiktokStatus');
    try {
        const res = await fetch('/api/tiktok-validate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accessToken, advertiserId })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        localStorage.setItem('tiktok_token', accessToken);
        localStorage.setItem('tiktok_advertiser', advertiserId);
        setTikTokBadge(true);
        showStatus('tiktokStatus', `✅ Conectado: ${data.accountName}`, 'success');
        $('badgeSetup').textContent = '✓'; $('badgeSetup').classList.add('visible');
        setTimeout(closeTikTokPanel, 1200);
    } catch (err) {
        showStatus('tiktokStatus', `❌ ${err.message}`, 'error');
    } finally {
        $('btnVerifyTikTok').disabled = false;
        $('btnVerifyTikTok').textContent = '🔗 Verificar Conexión';
    }
}

// ── Product picker ──────────────────────────────────────────
let _allProducts = [];

async function loadShopifyProducts() {
    const shop = localStorage.getItem('andromeda_shopify_shop');
    const token = localStorage.getItem('andromeda_shopify_token');
    if (!shop || !token) {
        showStatus('productPickerStatus', '❌ Conecta tu tienda Shopify primero en la pestaña Configuración', 'error');
        return;
    }
    $('btnLoadProducts').disabled = true;
    $('btnLoadProducts').innerHTML = '<span class="spinner-inline"></span>Cargando...';
    hideStatus('productPickerStatus');
    try {
        const res = await fetch('/api/shopify-products', {
            method: 'POST',
            headers: { 'x-shopify-shop': shop, 'x-shopify-token': token, 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        _allProducts = data.products;
        $('productPickerWrap').classList.remove('hidden');
        $('productSearchInput').value = '';
        renderProductList('');
        $('productSearchInput').focus();
        showStatus('productPickerStatus', `✅ ${data.total} productos cargados — busca y selecciona`, 'success');
    } catch (err) {
        showStatus('productPickerStatus', `❌ ${err.message}`, 'error');
    } finally {
        $('btnLoadProducts').disabled = false;
        $('btnLoadProducts').textContent = '🛍️ Cargar desde Shopify';
    }
}

function renderProductList(query) {
    const q = (query || '').toLowerCase().trim();
    const filtered = q
        ? _allProducts.filter(p => p.title.toLowerCase().includes(q) || (p.type || '').toLowerCase().includes(q) || (p.tags || '').toLowerCase().includes(q))
        : _allProducts;

    const list = $('productResultsList');
    if (filtered.length === 0) {
        list.innerHTML = `<div class="product-result-empty">Sin resultados para "${query}"</div>`;
        return;
    }
    list.innerHTML = filtered.map(p => `
        <div class="product-result-item" data-id="${p.id}">
            ${p.image
            ? `<img src="${p.image}" class="product-result-img" alt="" loading="lazy" />`
            : `<div class="product-result-img product-result-no-img">📦</div>`}
            <div class="product-result-info">
                <span class="product-result-name">${p.title}</span>
                <span class="product-result-price">$${p.price}</span>
            </div>
        </div>
    `).join('');

    list.querySelectorAll('.product-result-item').forEach(item => {
        item.addEventListener('click', () => {
            const product = _allProducts.find(p => String(p.id) === item.dataset.id);
            if (product) selectProduct(product);
        });
    });
}

async function selectProduct(minimalProduct) {
    // Hide search, show preview immediately with minimal data + loading state
    $('productPickerWrap').classList.add('hidden');

    const img = $('selectedProductImg');
    if (minimalProduct.image) { img.src = minimalProduct.image; img.classList.remove('hidden'); }
    else img.classList.add('hidden');

    $('selectedProductName').textContent = minimalProduct.title;
    $('selectedProductPrice').textContent = `$${minimalProduct.price}`;
    $('selectedProductDesc').textContent = 'Cargando detalles...';
    $('selectedProductPreview').classList.remove('hidden');

    // Store minimal data immediately so concepts can use title+price while full data loads
    state.selectedProduct = { ...minimalProduct };

    // Lazy-load full product details
    const shop = localStorage.getItem('andromeda_shopify_shop');
    const token = localStorage.getItem('andromeda_shopify_token');
    if (shop && token) {
        try {
            const res = await fetch('/api/shopify-product', {
                method: 'POST',
                headers: { 'x-shopify-shop': shop, 'x-shopify-token': token, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: minimalProduct.id })
            });
            const full = await res.json();
            if (res.ok) {
                state.selectedProduct = full;
                $('selectedProductDesc').textContent = full.description?.substring(0, 150) || '';

                // Auto-generate briefing with AI
                if ($('b1')) {
                    $('b1').value = '✨ Generando briefing con IA...';
                    $('b2').value = ''; $('b3').value = ''; $('b4').value = '';
                    try {
                        const ar = await fetch('/api/analyze-product', {
                            method: 'POST',
                            headers: aiHeaders(),
                            body: JSON.stringify({ product: full })
                        });
                        const analysis = await ar.json();
                        if (ar.ok) {
                            $('b1').value = analysis.product || '';
                            $('b2').value = analysis.audience || '';
                            $('b3').value = analysis.painPoint || '';
                            $('b4').value = analysis.differentiator || '';
                            if (analysis.tone) {
                                document.querySelectorAll('.tone-btn').forEach(btn => {
                                    btn.classList.remove('selected');
                                    if (btn.dataset.tone === analysis.tone) {
                                        btn.classList.add('selected');
                                        $('b5').value = analysis.tone;
                                    }
                                });
                            }
                        } else {
                            $('b1').value = `${full.title} — $${full.price}`;
                        }
                    } catch {
                        $('b1').value = `${full.title} — $${full.price}`;
                    }
                }
            } else {
                $('selectedProductDesc').textContent = '';
            }
        } catch {
            $('selectedProductDesc').textContent = '';
        }
    }

    hideStatus('productPickerStatus');
    showStatus('productPickerStatus', `✅ ${minimalProduct.title} seleccionado`, 'success');
}

function clearSelectedProduct() {
    state.selectedProduct = null;
    $('selectedProductPreview').classList.add('hidden');
    if ($('b1')) { $('b1').value = ''; $('b2').value = ''; $('b3').value = ''; $('b4').value = ''; $('b5').value = ''; }
    document.querySelectorAll('.tone-btn').forEach(b => b.classList.remove('selected'));
    if (_allProducts.length > 0) {
        $('productSearchInput').value = '';
        renderProductList('');
        $('productPickerWrap').classList.remove('hidden');
    }
    hideStatus('productPickerStatus');
}

// ── Briefing → Concepts ────────────────────────────────────
async function generateConcepts() {
    const b = {
        product: $('b1').value.trim(),
        audience: $('b2').value.trim(),
        painPoint: $('b3').value.trim(),
        differentiator: $('b4').value.trim(),
        tone: $('b5').value.trim()
    };
    if (!b.product || !b.audience || !b.painPoint) {
        showStatus('briefingStatus', 'Rellena al menos las 3 primeras preguntas', 'error');
        return;
    }

    showLoader('El Agente Copywriter está generando 10 conceptos...');
    hideStatus('briefingStatus');

    try {
        const res = await fetch('/api/generate-concepts', {
            method: 'POST',
            headers: aiHeaders(),
            body: JSON.stringify({ briefing: b, selectedProduct: state.selectedProduct || null })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        state.briefing = b;
        state.concepts = data.concepts.map(c => ({ ...c, selected: false, imageB64: null }));
        saveState();

        $('badgeBriefing').textContent = '✓';
        $('badgeBriefing').classList.add('visible');
        $('badgeConcepts').textContent = state.concepts.length;
        $('badgeConcepts').classList.add('visible');

        hideLoader();
        renderConcepts();
        switchView('concepts');
    } catch (err) {
        hideLoader();
        showStatus('briefingStatus', `❌ ${err.message}`, 'error');
    }
}

// ── Concepts rendering ────────────────────────────────────
let _activeFunnelFilter = 'all';

const FUNNEL_LABELS = { tofu: '🔵 TOFU', mofu: '🟠 MOFU', bofu: '🔴 BOFU' };

// Assign default funnelStage to legacy concepts that lack it (4 tofu, 3 mofu, 3 bofu)
const DEFAULT_STAGES = ['tofu','tofu','tofu','tofu','mofu','mofu','mofu','bofu','bofu','bofu'];

function renderConcepts() {
    const grid = $('conceptsGrid');
    grid.innerHTML = '';
    // Check if ANY concept has a real funnelStage
    const hasFunnel = state.concepts.some(c => c.funnelStage);
    state.concepts.forEach((c, i) => {
        const stage = c.funnelStage || (hasFunnel ? 'tofu' : DEFAULT_STAGES[i] || 'tofu');
        if (_activeFunnelFilter !== 'all' && stage !== _activeFunnelFilter) return;
        const card = document.createElement('div');
        card.className = 'concept-card' + (c.selected ? ' selected' : '');
        card.dataset.index = i;
        card.dataset.funnel = stage;
        card.innerHTML = `
            <div class="concept-num">
                Concepto ${i + 1} — ${c.targetEmotion || ''}
                <span class="funnel-badge funnel-badge-${stage}">${FUNNEL_LABELS[stage] || stage}</span>
            </div>
            <div class="concept-angle">${c.angle}</div>
            <div class="concept-headline">"${c.headline}"</div>
            <div class="concept-body">${c.body}</div>
            <div class="concept-cta">${c.cta}</div>
            <div class="concept-pain">💔 ${c.painPoint}</div>
            ${c.imageB64 ? `<div class="concept-creative"><img class="concept-img" src="data:image/png;base64,${c.imageB64}" /></div>` : ''}
            <div class="concept-footer">
                <div class="concept-check">${c.selected ? '✓' : ''}</div>
                <div class="concept-actions">
                    <button class="btn btn-secondary btn-sm btn-gen-creative" data-index="${i}">🎨 Imagen</button>
                    <button class="btn btn-secondary btn-sm btn-gen-script" data-index="${i}">🎬 Script</button>
                    <button class="btn btn-secondary btn-sm btn-gen-landing" data-index="${i}">🌐 Landing</button>
                </div>
            </div>
        `;
        card.addEventListener('click', (e) => {
            if (e.target.closest('.btn-gen-creative') || e.target.closest('.btn-gen-script') || e.target.closest('.btn-gen-landing')) return;
            toggleConceptSelection(i, card);
        });
        card.querySelector('.btn-gen-creative').addEventListener('click', () => openModal(i));
        card.querySelector('.btn-gen-script').addEventListener('click', () => openScriptModal(i));
        card.querySelector('.btn-gen-landing').addEventListener('click', () => openLandingModal(i));
        grid.appendChild(card);
    });
    updateConceptsToolbar();
}

function filterConceptsByFunnel(stage) {
    _activeFunnelFilter = stage;
    document.querySelectorAll('.funnel-tab').forEach(t => t.classList.toggle('active', t.dataset.funnel === stage));
    renderConcepts();
}

function toggleConceptSelection(index, card) {
    state.concepts[index].selected = !state.concepts[index].selected;
    card.classList.toggle('selected', state.concepts[index].selected);
    card.querySelector('.concept-check').textContent = state.concepts[index].selected ? '✓' : '';
    saveState();
    updateConceptsToolbar();
}

function toggleSelectAllConcepts() {
    const allSelected = state.concepts.every(c => c.selected);
    state.concepts.forEach(c => c.selected = !allSelected);
    saveState();
    renderConcepts();
}

function updateConceptsToolbar() {
    const count = state.concepts.filter(c => c.selected).length;
    $('conceptsSelectedCount').textContent = `${count} seleccionado${count !== 1 ? 's' : ''}`;
    $('btnGoToCampaign').disabled = count === 0;
}

// ── Creative Modal ─────────────────────────────────────────
let currentConceptIndex = null;
let selectedShopifyImageUrl = null;

function openModal(index) {
    currentConceptIndex = index;
    selectedShopifyImageUrl = null;
    const c = state.concepts[index];
    $('modalTitle').textContent = `Creativo: ${c.angle}`;
    $('creativeModal').classList.remove('hidden');
    $('modalResult').classList.add('hidden');
    hideStatus('modalStatus');

    // Populate shopify photos grid
    const grid = $('shopifyPhotosGrid');
    const empty = $('shopifyPhotosEmpty');
    const images = state.selectedProduct?.images || (state.selectedProduct?.image ? [state.selectedProduct.image] : []);
    grid.innerHTML = '';
    if (images.length > 0) {
        empty.classList.add('hidden');
        grid.classList.remove('hidden');
        images.forEach(url => {
            const item = document.createElement('div');
            item.className = 'shopify-photo-item';
            item.innerHTML = `<img src="${url}" loading="lazy" />`;
            item.addEventListener('click', () => {
                grid.querySelectorAll('.shopify-photo-item').forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
                selectedShopifyImageUrl = url;
            });
            grid.appendChild(item);
        });
    } else {
        grid.classList.add('hidden');
        empty.classList.remove('hidden');
    }
}
function closeModal() { $('creativeModal').classList.add('hidden'); currentConceptIndex = null; selectedShopifyImageUrl = null; }

function setupFileUpload(areaId, inputId, previewId) {
    const area = $(areaId);
    const input = $(inputId);
    const preview = $(previewId);
    area.addEventListener('click', () => input.click());
    area.addEventListener('dragover', e => { e.preventDefault(); area.style.borderColor = 'var(--accent)'; });
    area.addEventListener('drop', e => {
        e.preventDefault();
        area.style.borderColor = '';
        const file = e.dataTransfer.files[0];
        if (file) readFileToPreview(file, preview);
    });
    input.addEventListener('change', () => {
        if (input.files[0]) readFileToPreview(input.files[0], preview);
    });
}
function readFileToPreview(file, previewEl) {
    const reader = new FileReader();
    reader.onload = e => { previewEl.src = e.target.result; previewEl.classList.remove('hidden'); };
    reader.readAsDataURL(file);
}

async function generateCreative() {
    if (currentConceptIndex === null) return;
    const c = state.concepts[currentConceptIndex];
    const activeTab = document.querySelector('.modal-tab.active')?.dataset.mode || 'generate';
    const style = $('genStyle')?.value.trim() || '';

    $('btnGenerateCreative').disabled = true;
    $('btnGenerateCreative').innerHTML = '<span class="spinner-inline"></span>Generando...';
    hideStatus('modalStatus');

    try {
        // mode 'shopify' maps to 'edit' on the backend using the product's own photo
        const backendMode = activeTab === 'shopify' ? 'edit' : activeTab;
        let body = { mode: backendMode, concept: c, style, selectedProduct: state.selectedProduct || null };

        if (activeTab === 'shopify') {
            if (!selectedShopifyImageUrl) throw new Error('Selecciona una foto del producto');
            // Fetch the Shopify CDN image and convert to base64
            const imgRes = await fetch(selectedShopifyImageUrl);
            if (!imgRes.ok) throw new Error('No se pudo cargar la imagen del producto');
            const blob = await imgRes.blob();
            const b64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = e => resolve(e.target.result.split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
            body.imageBase64 = b64;
            body.mimeType = blob.type || 'image/jpeg';
        } else if (activeTab === 'edit') {
            const src = $('photoPreview')?.src;
            if (!src || src === window.location.href) throw new Error('Sube una foto de producto');
            body.imageBase64 = src.split(',')[1];
            body.mimeType = 'image/jpeg';
        } else if (activeTab === 'manual') {
            const src = $('manualPreview')?.src;
            if (!src || src === window.location.href) throw new Error('Sube la imagen del anuncio');
            body.imageBase64 = src.split(',')[1];
            body.mimeType = 'image/jpeg';
        }

        const res = await fetch('/api/generate-creative', {
            method: 'POST',
            headers: aiHeaders(),
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        const b64 = data.b64;
        state.concepts[currentConceptIndex].imageB64 = b64;
        saveState();

        $('generatedCreative').src = `data:image/png;base64,${b64}`;
        $('btnDownloadCreative').href = `data:image/png;base64,${b64}`;
        $('modalResult').classList.remove('hidden');
        renderConcepts();
    } catch (err) {
        showStatus('modalStatus', `❌ ${err.message}`, 'error');
    } finally {
        $('btnGenerateCreative').disabled = false;
        $('btnGenerateCreative').textContent = '🎨 Generar';
    }
}

// ── Research ───────────────────────────────────────────────
async function startResearch() {
    const url = $('competitorUrlInput')?.value?.trim();
    if (!url) {
        showStatus('researchStatus', '⚠️ Introduce la URL de Meta Ad Library del competidor', 'warning');
        return;
    }

    const btn = $('btnStartResearch');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-inline"></span>Espionando...';
    showStatus('researchStatus', 'Analizando anuncios del competidor con IA...', 'info');
    $('researchResults')?.classList.add('hidden');

    try {
        const headers = { ...aiHeaders(), ...metaHeaders() };
        const res = await fetch('/api/research-extract', {
            method: 'POST',
            headers,
            body: JSON.stringify({ url })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        // Update state
        state.research.competitor = data.competitor;
        state.research.ads = data.ads || [];
        state.research.funnelCount = data.funnels || 0;
        state.research.report = data.report || '';

        // Update summary banner
        $('resCompetitorName').textContent = data.competitor;
        $('resAdCount').textContent = state.research.ads.length;
        $('resFunnelCount').textContent = data.funnels || 0;

        // Render ads grid
        const grid = $('competitorAdsGrid');
        grid.innerHTML = state.research.ads.map((ad, i) => {
            const funnelClass = { tofu: 'funnel-badge-tofu', mofu: 'funnel-badge-mofu', bofu: 'funnel-badge-bofu' }[ad.funnelStage] || 'funnel-badge-tofu';
            const funnelLabel = { tofu: '🔵 TOFU', mofu: '🟠 MOFU', bofu: '🔴 BOFU' }[ad.funnelStage] || '🔵 TOFU';
            const media = ad.type === 'video'
                ? `<video class="concept-img" src="${ad.mediaUrl}" poster="${ad.posterUrl || ''}" controls muted style="width:100%;border-radius:8px;margin-bottom:8px"></video>`
                : `<img class="concept-img" src="${ad.mediaUrl}" alt="Ad ${i + 1}" style="width:100%;border-radius:8px;margin-bottom:8px;object-fit:cover;max-height:200px" onerror="this.style.display='none'" />`;
            return `
                <div class="concept-card" style="cursor:default">
                    <div class="concept-num">
                        Anuncio ${i + 1}
                        ${ad.funnelStage ? `<span class="funnel-badge ${funnelClass}">${funnelLabel}</span>` : ''}
                        ${ad.impressions ? `<span style="font-size:10px;color:var(--text-dim);margin-left:8px">👁 ${ad.impressions}</span>` : ''}
                    </div>
                    ${media}
                    <div class="concept-headline">"${ad.headline || '—'}"</div>
                    <div class="concept-body">${ad.body || '—'}</div>
                    <div class="concept-cta">${ad.cta || '—'}</div>
                    ${ad.snapshotUrl ? `<div style="margin-top:6px"><a href="${ad.snapshotUrl}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm" style="font-size:11px">🔗 Ver en Meta</a></div>` : ''}
                </div>
            `;
        }).join('');

        // Render strategy report
        $('strategyReportContent').innerHTML = data.report || '<p class="table-empty">Sin datos de reporte</p>';

        // Show results
        $('researchResults').classList.remove('hidden');
        hideStatus('researchStatus');
        if (data.source === 'mock') {
            showStatus('researchStatus', '💡 Datos de ejemplo (añade tu token de Meta para datos reales)', 'warning');
        }
    } catch (err) {
        showStatus('researchStatus', `❌ ${err.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '🚀 Iniciar Espionaje con IA';
    }
}

// ── Campaign ───────────────────────────────────────────────
function updateBudgetHint() {
    const budget = parseFloat($('dailyBudget').value) || 5;
    const days = parseInt($('campaignDuration').value) || 7;
    const selected = state.concepts.filter(c => c.selected).length || 1;
    const total = budget * days * selected;
    $('budgetHint').textContent = `$${budget}/día × ${days} días × ${selected} ad set${selected !== 1 ? 's' : ''} = $${total.toFixed(0)} total`;
}

function renderSelectedSummary() {
    const selected = state.concepts.filter(c => c.selected);
    $('selectedCount').textContent = selected.length;
    const list = $('selectedConceptsList');
    list.innerHTML = selected.map((c, i) => `
        <div class="selected-item">
            ${c.imageB64 ? `<img src="data:image/png;base64,${c.imageB64}" style="width:48px;height:48px;border-radius:6px;object-fit:cover" />` : '<span style="font-size:24px">💡</span>'}
            <div>
                <div style="font-weight:700;font-size:13px">${c.angle}</div>
                <div style="font-size:11px;color:var(--text-dim)">${c.headline}</div>
            </div>
        </div>
    `).join('');
    updateBudgetHint();
}

async function launchCampaign() {
    const platform = $('activePlatform').value || 'meta';
    const selected = state.concepts.filter(c => c.selected);
    if (selected.length === 0) {
        showStatus('campaignStatus', '❌ Selecciona al menos un concepto', 'error'); return;
    }

    // Check platform credentials
    const platformNames = { meta: 'Meta', google: 'Google Ads', tiktok: 'TikTok Ads' };
    const credChecks = {
        meta: () => localStorage.getItem('meta_token') && localStorage.getItem('meta_account'),
        google: () => localStorage.getItem('google_token') && localStorage.getItem('google_customer'),
        tiktok: () => localStorage.getItem('tiktok_token') && localStorage.getItem('tiktok_advertiser')
    };
    if (!credChecks[platform]?.()) {
        showStatus('campaignStatus', `❌ Conecta tu cuenta de ${platformNames[platform]} primero (pestaña Configuración)`, 'error'); return;
    }

    // Validate all required campaign fields
    const fieldErrors = validateCampaignFields();
    if (fieldErrors.length) {
        showStatus('campaignStatus', `❌ Completa los campos obligatorios antes de lanzar: ${fieldErrors.join(', ')}`, 'error');
        return;
    }

    const payload = {
        campaignName: $('campaignName').value.trim(),
        objective: $('campaignObjective').value,
        dailyBudgetUsd: parseFloat($('dailyBudget').value) || 5,
        durationDays: parseInt($('campaignDuration').value) || 7,
        destinationUrl: $('destinationUrl').value.trim(),
        targeting: {
            countries: $('targetCountries').value.split(',').map(s => s.trim().toUpperCase()),
            ageMin: parseInt($('ageMin').value) || 18,
            ageMax: parseInt($('ageMax').value) || 45,
            gender: $('targetGender').value,
            interests: $('targetInterests').value.split(',').map(s => s.trim())
        },
        // Strip imageB64 (too large), pass imageUrl instead so the backend uploads by URL
        concepts: selected.map(({ imageB64, ...c }) => ({
            ...c,
            imageUrl: c.imageUrl || (state.selectedProduct?.image || null)
        }))
    };

    const apiMap = { meta: '/api/meta-create-campaign', google: '/api/google-create-campaign', tiktok: '/api/tiktok-create-campaign' };
    const hdrMap = { meta: metaHeaders(), google: googleHeaders(), tiktok: tiktokHeaders() };

    showLoader(`Lanzando campaña en ${platformNames[platform]}...`);
    hideStatus('campaignStatus');

    try {
        const res = await fetch(apiMap[platform], { method: 'POST', headers: hdrMap[platform], body: JSON.stringify(payload) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        const campaign = {
            id: data.campaignId, name: payload.campaignName,
            adSetIds: data.adSetIds, adIds: data.adIds,
            platform, createdAt: new Date().toISOString(),
            destinationUrl: payload.destinationUrl,
            conceptAngles: selected.map(c => c.angle)
        };
        state.campaigns.push(campaign);
        saveState();

        $('badgeCampaign').textContent = '✓'; $('badgeCampaign').classList.add('visible');
        $('badgeDashboard').classList.add('visible');
        hideLoader();

        // Show result
        const adsCreated = data.adIds?.length || 0;
        const setsCreated = data.adSetIds?.length || 0;

        if (data.warnings?.length) {
            // Warnings mean some ads failed — show them prominently
            const warnText = data.warnings.join(' | ');
            showStatus('campaignStatus',
                `⚠️ Campaña creada (${setsCreated} Ad Sets, ${adsCreated} Ads) pero con errores:\n${warnText}`,
                'warning');
        } else {
            showStatus('campaignStatus',
                `✅ Campaña creada en PAUSA — ${setsCreated} Ad Sets, ${adsCreated} Anuncios (ID: ${data.campaignId})`,
                'success');
        }

        // Auto-upload AI-generated images if platform is Meta and any concept has imageB64
        const hasImages = platform === 'meta' && selected.some(c => c.imageB64);
        if (hasImages) {
            setTimeout(() => uploadPendingImages(campaign, selected), 800);
        } else {
            setTimeout(() => { populateCampaignSelector(); switchView('dashboard'); }, 1500);
        }
    } catch (err) {
        hideLoader();
        showStatus('campaignStatus', `❌ ${err.message}`, 'error');
    }
}

// ── Image Upload to Running Campaign ───────────────────────

async function uploadPendingImages(campaign, conceptsArg) {
    const { adSetIds, destinationUrl, conceptAngles } = campaign;
    if (!adSetIds?.length) { populateCampaignSelector(); switchView('dashboard'); return; }

    // Build list of concepts to upload (keep imageB64)
    let concepts = conceptsArg;
    if (!concepts) {
        // Match by stored angles
        const angles = conceptAngles || [];
        concepts = angles.map(angle => state.concepts.find(c => c.angle === angle)).filter(Boolean);
    }

    const hasAnyImage = concepts.some(c => c.imageB64);
    if (!hasAnyImage) { populateCampaignSelector(); switchView('dashboard'); return; }

    const destUrl = destinationUrl || $('destinationUrl')?.value?.trim() || '';
    if (!destUrl) {
        showStatus('campaignStatus', '⚠️ Campaña lanzada pero sin URL de destino para subir imágenes', 'warning');
        populateCampaignSelector(); switchView('dashboard'); return;
    }

    const newAdIds = [...(campaign.adIds || [])];
    let uploaded = 0, failed = 0;
    const uploadErrors = [];

    // Iterate keeping index aligned: concepts[i] → adSetIds[i]
    for (let i = 0; i < Math.min(concepts.length, adSetIds.length); i++) {
        const concept = concepts[i];
        const adSetId = adSetIds[i];
        if (!concept?.imageB64 || !adSetId) continue;

        showStatus('campaignStatus', `📤 Subiendo imagen ${i + 1}/${toUpload.length} a Meta...`, 'info');

        try {
            const res = await fetch('/api/meta-upload-creative', {
                method: 'POST',
                headers: metaHeaders(),
                body: JSON.stringify({
                    adSetId,
                    imageB64: concept.imageB64,
                    headline: concept.headline,
                    body: concept.body,
                    destinationUrl: destUrl
                })
            });
            const d = await res.json();
            if (!res.ok) throw new Error(d.error);
            newAdIds.push(d.adId);
            uploaded++;
        } catch (e) {
            uploadErrors.push(`AdSet ${adSetId}: ${e.message}`);
            failed++;
        }
    }

    // Persist updated adIds
    const idx = state.campaigns.findIndex(c => c.id === campaign.id);
    if (idx >= 0) { state.campaigns[idx].adIds = newAdIds; saveState(); }

    const errorDetail = uploadErrors.length ? `\n⚠️ ${uploadErrors.join('\n⚠️ ')}` : '';
    const msg = failed > 0
        ? `⏸️ Campaña en pausa — ${uploaded} imagen${uploaded !== 1 ? 'es' : ''} subida${uploaded !== 1 ? 's' : ''}, ${failed} fallaron${errorDetail}`
        : `⏸️ Campaña en pausa con ${uploaded} imagen${uploaded !== 1 ? 'es' : ''} — Actívala en Meta Ads Manager cuando estés listo`;
    showStatus('campaignStatus', msg, uploaded > 0 ? 'success' : 'error');

    populateCampaignSelector();
    switchView('dashboard');
    // Show upload panel if there are concepts still without images
    setTimeout(checkPendingUploads, 500);
}

function checkPendingUploads() {
    const sel = $('campaignSelector');
    const campaignId = sel?.value;
    const panel = $('pendingImagesPanel');
    if (!panel) return;

    const campaign = state.campaigns.find(c => c.id === campaignId);
    if (!campaign || campaign.platform !== 'meta') { panel.classList.add('hidden'); return; }

    const angles = campaign.conceptAngles || [];
    const concepts = angles.map(a => state.concepts.find(c => c.angle === a)).filter(c => c?.imageB64);
    const pendingCount = concepts.length - (campaign.adIds?.length || 0);

    if (pendingCount <= 0) { panel.classList.add('hidden'); return; }

    panel.classList.remove('hidden');
    $('pendingCount').textContent = pendingCount;
}

async function uploadToExistingCampaign() {
    const campaignId = $('campaignSelector').value;
    const campaign = state.campaigns.find(c => c.id === campaignId);
    if (!campaign) return;

    $('btnUploadPending').disabled = true;
    $('btnUploadPending').textContent = 'Subiendo...';

    await uploadPendingImages(campaign, null);

    $('btnUploadPending').disabled = false;
    $('btnUploadPending').textContent = 'Subir imágenes';
    checkPendingUploads();
}

// ── Dashboard ──────────────────────────────────────────────
const PLATFORM_ICONS = { meta: '📘', google: '🔵', tiktok: '🎵' };

function populateCampaignSelector() {
    const sel = $('campaignSelector');
    const currentVal = sel.value;
    sel.innerHTML = '<option value="">Selecciona una campaña...</option>';
    state.campaigns.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.dataset.platform = c.platform || 'meta';
        const icon = PLATFORM_ICONS[c.platform || 'meta'] || '📢';
        opt.textContent = `${icon} ${c.name} (${new Date(c.createdAt).toLocaleDateString('es')})`;
        sel.appendChild(opt);
    });
    if (currentVal) sel.value = currentVal;
}

async function refreshStats() {
    const campaignId = $('campaignSelector').value;
    if (!campaignId) return;

    const campaign = state.campaigns.find(c => c.id === campaignId);
    const platform = campaign?.platform || 'meta';

    const apiMap = {
        meta: [`/api/meta-stats?campaignId=${campaignId}`, metaHeaders()],
        google: [`/api/google-stats?campaignId=${campaignId}`, googleHeaders()],
        tiktok: [`/api/tiktok-stats?campaignId=${campaignId}`, tiktokHeaders()]
    };
    const [url, headers] = apiMap[platform] || apiMap.meta;

    $('btnRefreshStats').innerHTML = '<span class="spinner-inline"></span>';
    try {
        const res = await fetch(url, { headers });
        const data = await res.json();
        if (checkTokenExpired(data)) return;
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        renderStats(data);
    } catch (err) {
        showToast(`Error al obtener stats: ${err.message}`);
    } finally {
        $('btnRefreshStats').innerHTML = '↺ Actualizar';
    }
}

function renderStats(data) {
    const kpis = data.summary || {};
    $('kpiSpend').textContent = `$${(kpis.spend || 0).toFixed(2)}`;
    $('kpiImpressions').textContent = (kpis.impressions || 0).toLocaleString();
    $('kpiClicks').textContent = (kpis.clicks || 0).toLocaleString();
    $('kpiCtr').textContent = `${(kpis.ctr || 0).toFixed(2)}%`;
    $('kpiCpm').textContent = `$${(kpis.cpm || 0).toFixed(2)}`;
    $('kpiConversions').textContent = (kpis.conversions || 0).toLocaleString();

    const tbody = $('adsTableBody');
    tbody.innerHTML = '';
    (data.ads || []).forEach(ad => {
        const ctr = parseFloat(ad.ctr || 0);
        const roas = parseFloat(ad.roas || 0);
        let rowClass = 'row-hold', tag = 'tag-hold', label = 'Mantener';
        if (ctr > 2 || roas > 1.5) { rowClass = 'row-scale'; tag = 'tag-scale'; label = '⬆ Escalar'; }
        else if (ctr < 0.5 || (roas > 0 && roas < 0.8)) { rowClass = 'row-pause'; tag = 'tag-pause'; label = '⏸ Pausar'; }
        const tr = document.createElement('tr');
        tr.className = rowClass;
        tr.innerHTML = `
            <td>${ad.name || ad.id}</td>
            <td>$${parseFloat(ad.spend || 0).toFixed(2)}</td>
            <td>${parseInt(ad.impressions || 0).toLocaleString()}</td>
            <td>${parseFloat(ad.ctr || 0).toFixed(2)}%</td>
            <td>$${parseFloat(ad.cpm || 0).toFixed(2)}</td>
            <td>${ad.conversions || 0}</td>
            <td>${roas > 0 ? roas.toFixed(2) + 'x' : '—'}</td>
            <td><span class="${tag}">${label}</span></td>
        `;
        tbody.appendChild(tr);
    });
}

async function analyzeWithAI() {
    const campaignId = $('campaignSelector').value;
    if (!campaignId) { alert('Selecciona una campaña primero'); return; }

    showLoader('Agente Media Buyer analizando rendimiento...');
    try {
        const statsRes = await fetch(`/api/meta-stats?campaignId=${campaignId}`, { headers: metaHeaders() });
        const statsData = await statsRes.json();
        if (!statsRes.ok) throw new Error(statsData.error);

        const res = await fetch('/api/meta-optimize', {
            method: 'POST',
            headers: { ...metaHeaders(), ...aiHeaders() },
            body: JSON.stringify({ campaignId, stats: statsData, briefing: state.briefing })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        state.pendingOptimizations = data;
        renderOptimizations(data);
        hideLoader();
    } catch (err) {
        hideLoader();
        alert(`Error: ${err.message}`);
    }
}

function renderOptimizations(data) {
    const panel = $('optimizationPanel');
    const content = $('optimizationContent');
    panel.classList.remove('hidden');

    let html = `<div class="opt-section"><h4>📊 Análisis General</h4><div class="opt-item">${data.insights || ''}</div></div>`;

    if (data.pause?.length > 0) {
        html += `<div class="opt-section"><h4>⏸ Pausar (bajo rendimiento)</h4>`;
        data.pause.forEach(id => { html += `<div class="opt-item">Ad ID: ${id}</div>`; });
        html += '</div>';
    }
    if (data.scale?.length > 0) {
        html += `<div class="opt-section"><h4>⬆ Escalar (alto rendimiento)</h4>`;
        data.scale.forEach(s => { html += `<div class="opt-item">Ad ID: ${s.adId} → Nuevo presupuesto: $${s.newBudget}/día</div>`; });
        html += '</div>';
    }
    if (data.copyTweaks) {
        html += `<div class="opt-section"><h4>✏️ Mejoras de Copy Sugeridas</h4><div class="opt-item">${data.copyTweaks}</div></div>`;
    }

    content.innerHTML = html;
    if ((data.pause?.length || 0) + (data.scale?.length || 0) > 0) {
        $('btnApplyOptimizations').classList.remove('hidden');
    }
}

async function applyOptimizations() {
    if (!state.pendingOptimizations) return;
    if (!confirm('¿Aplicar las recomendaciones de la IA en Meta Ads?')) return;

    showLoader('Aplicando optimizaciones en Meta...');
    try {
        const res = await fetch('/api/meta-optimize', {
            method: 'PATCH',
            headers: metaHeaders(),
            body: JSON.stringify(state.pendingOptimizations)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        hideLoader();
        state.pendingOptimizations = null;
        $('btnApplyOptimizations').classList.add('hidden');
        alert('✅ Optimizaciones aplicadas correctamente');
        await refreshStats();
    } catch (err) {
        hideLoader();
        alert(`Error: ${err.message}`);
    }
}

// ── Claude Chat ────────────────────────────────────────────

const chatHistory = []; // [{role, content}] — persists during session

function chatContext() {
    return {
        briefing: state.briefing,
        concepts: (state.concepts || []).map(c => ({
            angle: c.angle, headline: c.headline, body: c.body,
            hook: c.hook, cta: c.cta, selected: c.selected
        })),
        campaign: {
            dailyBudget: parseFloat($('dailyBudget')?.value) || 5,
            duration: parseInt($('campaignDuration')?.value) || 7,
            countries: $('targetCountries')?.value || 'ES',
            ageMin: parseInt($('ageMin')?.value) || 18,
            ageMax: parseInt($('ageMax')?.value) || 45,
            gender: $('targetGender')?.value || 'all'
        }
    };
}

function renderChatMsg(role, text) {
    const div = document.createElement('div');
    div.className = `chat-msg ${role}`;
    div.innerHTML = text.replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    $('chatMessages').appendChild(div);
    $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
    return div;
}

function toolUseLabel(name, input) {
    if (name === 'update_concept') {
        const parts = [];
        if (input.headline) parts.push(`Headline → "${input.headline}"`);
        if (input.body) parts.push(`Body → "${input.body}"`);
        if (input.hook) parts.push(`Hook → "${input.hook}"`);
        if (input.cta) parts.push(`CTA → "${input.cta}"`);
        return { title: `Modificar concepto [${input.index}]`, desc: parts.join('<br>') };
    }
    if (name === 'update_campaign_settings') {
        const parts = [];
        if (input.dailyBudget !== undefined) parts.push(`Presupuesto → $${input.dailyBudget}/día`);
        if (input.duration !== undefined) parts.push(`Duración → ${input.duration} días`);
        if (input.campaignName) parts.push(`Nombre → "${input.campaignName}"`);
        return { title: 'Modificar campaña', desc: parts.join('<br>') };
    }
    if (name === 'update_targeting') {
        const parts = [];
        if (input.countries) parts.push(`Países → ${input.countries.join(', ')}`);
        if (input.ageMin !== undefined || input.ageMax !== undefined)
            parts.push(`Edad → ${input.ageMin || '?'}-${input.ageMax || '?'}`);
        if (input.gender) parts.push(`Género → ${input.gender === '1' ? 'Hombres' : input.gender === '2' ? 'Mujeres' : 'Todos'}`);
        return { title: 'Modificar targeting', desc: parts.join('<br>') };
    }
    if (name === 'select_concepts') {
        return {
            title: `${input.action === 'select' ? 'Seleccionar' : 'Deseleccionar'} conceptos`,
            desc: `Índices: ${input.indices.join(', ')}`
        };
    }
    if (name === 'create_strategy') {
        return {
            title: `📁 Guardar estrategia "${input.name}"`,
            desc: `Tono: ${input.tone}<br>${input.product?.substring(0, 80)}...`
        };
    }
    return { title: name, desc: JSON.stringify(input) };
}

function applyToolUse(name, input) {
    if (name === 'update_concept') {
        const c = state.concepts[input.index];
        if (!c) return;
        if (input.headline !== undefined) c.headline = input.headline;
        if (input.body !== undefined) c.body = input.body;
        if (input.hook !== undefined) c.hook = input.hook;
        if (input.cta !== undefined) c.cta = input.cta;
        saveState();
        renderConcepts();
        updateCampaignSummary();
    }
    if (name === 'update_campaign_settings') {
        if (input.dailyBudget !== undefined) { $('dailyBudget').value = input.dailyBudget; updateBudgetHint(); }
        if (input.duration !== undefined) { $('campaignDuration').value = input.duration; updateBudgetHint(); }
        if (input.campaignName) $('campaignName').value = input.campaignName;
    }
    if (name === 'update_targeting') {
        if (input.countries) $('targetCountries').value = input.countries.join(', ');
        if (input.ageMin !== undefined) $('ageMin').value = input.ageMin;
        if (input.ageMax !== undefined) $('ageMax').value = input.ageMax;
        if (input.gender) $('targetGender').value = input.gender;
    }
    if (name === 'select_concepts') {
        for (const i of (input.indices || [])) {
            if (state.concepts[i]) state.concepts[i].selected = input.action === 'select';
        }
        saveState();
        renderConcepts();
        updateCampaignSummary();
    }
    if (name === 'create_strategy') {
        const list = loadStrategies();
        list.unshift({
            id: Date.now(),
            name: input.name,
            briefing: {
                product: input.product,
                audience: input.audience,
                painPoint: input.painPoint,
                differentiator: input.differentiator,
                tone: input.tone
            },
            createdAt: new Date().toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' })
        });
        persistStrategies(list);
        renderStrategies();
        // Also load it into the briefing form
        $('b1').value = input.product || '';
        $('b2').value = input.audience || '';
        $('b3').value = input.painPoint || '';
        $('b4').value = input.differentiator || '';
        $('b5').value = input.tone || '';
        document.querySelectorAll('.tone-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tone === input.tone);
        });
    }
}

function showPendingActions(toolUses) {
    const panel = $('chatPendingActions');
    if (!toolUses.length) { panel.classList.add('hidden'); return; }
    panel.innerHTML = toolUses.map(tu => {
        const { title, desc } = toolUseLabel(tu.name, tu.input);
        return `<div class="chat-action-card" data-tool="${tu.name}" data-input='${JSON.stringify(tu.input)}'>
            <div class="chat-action-card-title">⚡ ${title}</div>
            <div class="chat-action-card-desc">${desc}</div>
            <div class="chat-action-btns">
                <button class="btn-apply" onclick="applyActionCard(this)">✓ Aplicar</button>
                <button class="btn-ignore" onclick="this.closest('.chat-action-card').remove(); checkActionsPanel()">Ignorar</button>
            </div>
        </div>`;
    }).join('');
    panel.classList.remove('hidden');
}

window.applyActionCard = function (btn) {
    const card = btn.closest('.chat-action-card');
    const name = card.dataset.tool;
    const input = JSON.parse(card.dataset.input);
    applyToolUse(name, input);
    card.innerHTML = `<div style="color:#a3e635;font-size:12px;font-weight:600">✓ Aplicado</div>`;
    setTimeout(() => { card.remove(); checkActionsPanel(); }, 800);
};

window.checkActionsPanel = function () {
    const panel = $('chatPendingActions');
    if (!panel.querySelector('.chat-action-card')) panel.classList.add('hidden');
};

async function sendChatMessage() {
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    renderChatMsg('user', text);

    chatHistory.push({ role: 'user', content: text });

    const typing = renderChatMsg('assistant', '<span class="chat-typing">Jarvi está escribiendo...</span>');
    $('chatSend').disabled = true;

    try {
        const res = await fetch('/api/claude-chat', {
            method: 'POST',
            headers: aiHeaders(),
            body: JSON.stringify({ messages: chatHistory, context: chatContext() })
        });
        const data = await res.json();
        typing.remove();

        if (!res.ok) throw new Error(data.error);

        const replyText = data.text || '(sin respuesta)';
        renderChatMsg('assistant', replyText);

        // Add assistant reply to history (with full content for tool use continuity)
        chatHistory.push({
            role: 'assistant',
            content: [
                ...(replyText ? [{ type: 'text', text: replyText }] : []),
                ...(data.toolUses || [])
            ]
        });

        // Show tool use action cards
        if (data.toolUses?.length > 0) {
            showPendingActions(data.toolUses);
            // Add tool results to history so Claude knows they were applied
            chatHistory.push({
                role: 'user',
                content: data.toolUses.map(tu => ({
                    type: 'tool_result',
                    tool_use_id: tu.id,
                    content: 'Cambio aplicado correctamente'
                }))
            });
        }
    } catch (err) {
        typing.remove();
        const msg = err.message || '';
        if (msg.includes('Configura tu clave') || msg.includes('clave de IA')) {
            showChatKeyNotice();
        } else {
            renderChatMsg('error', `❌ ${msg}`);
        }
    } finally {
        $('chatSend').disabled = false;
        input.focus();
    }
}

function showChatKeyNotice() {
    const msgs = $('chatMessages');
    if (msgs.querySelector('.chat-key-notice')) return;
    const div = document.createElement('div');
    div.className = 'chat-key-notice';
    div.innerHTML = `
        <p>Para usar Jarvi necesitas configurar tu clave de IA.</p>
        <button onclick="window.goToAiSetup()">Ir a Configuración →</button>
    `;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
}

window.goToAiSetup = function () {
    $('chatPanel').classList.add('hidden');
    showView('setup');
    setTimeout(() => document.getElementById('anthropicKeyInput')?.focus(), 300);
};

function initChat() {
    $('chatToggle').addEventListener('click', () => {
        $('chatPanel').classList.toggle('hidden');
        if (!$('chatPanel').classList.contains('hidden') &&
            !localStorage.getItem('anthropic_key') && !localStorage.getItem('openai_key')) {
            showChatKeyNotice();
        }
    });
    $('chatClose').addEventListener('click', () => $('chatPanel').classList.add('hidden'));
    $('chatSend').addEventListener('click', sendChatMessage);
    $('chatInput').addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
    });
}

// ── Scaling Plans ──────────────────────────────────────────
const PLANS_KEY = 'andromeda_scaling_plans';
const METRICS = { roas: 'ROAS', ctr: 'CTR (%)', cpm: 'CPM ($)', spend: 'Gasto ($)', impressions: 'Impresiones', conversions: 'Conversiones' };
const OPERATORS = { '>': 'mayor que', '<': 'menor que', '>=': 'mayor o igual', '<=': 'menor o igual' };
const ACTIONS = { scale_budget: 'Aumentar presupuesto', reduce_budget: 'Reducir presupuesto', pause: 'Pausar anuncio', activate: 'Activar anuncio' };

let editingPlanId = null;

function loadPlans() { try { return JSON.parse(localStorage.getItem(PLANS_KEY) || '[]'); } catch { return []; } }
function persistPlans(l) { localStorage.setItem(PLANS_KEY, JSON.stringify(l)); }

function initScalingPlans() {
    $('btnNewPlan').addEventListener('click', () => openPlanModal());
    $('btnAddRule').addEventListener('click', addRuleRow);
    $('btnSavePlan').addEventListener('click', savePlan);
    $('btnCancelPlan').addEventListener('click', closePlanModal);
    $('btnClosePlanModal').addEventListener('click', closePlanModal);
    $('planModal').addEventListener('click', e => { if (e.target === $('planModal')) closePlanModal(); });

    // Platform tab switching
    $('planPlatformTabs').addEventListener('click', e => {
        const tab = e.target.closest('.plan-platform-tab');
        if (!tab) return;
        document.querySelectorAll('.plan-platform-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        $('planPlatformInput').value = tab.dataset.platform;
    });

    renderPlans();
}

function openPlanModal(plan = null) {
    editingPlanId = plan ? plan.id : null;
    $('planModalTitle').textContent = plan ? 'Editar plan' : 'Nuevo plan de escalado';
    $('planNameInput').value = plan ? plan.name : '';

    // Set platform tabs
    const platform = plan?.platform || 'meta';
    $('planPlatformInput').value = platform;
    document.querySelectorAll('.plan-platform-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.platform === platform);
    });

    $('planRulesContainer').innerHTML = '';
    const rules = plan ? plan.rules : [{}];
    rules.forEach(r => addRuleRow(r));
    $('planModal').classList.remove('hidden');
    setTimeout(() => $('planNameInput').focus(), 100);
}

function closePlanModal() { $('planModal').classList.add('hidden'); }

function addRuleRow(rule = {}) {
    const id = Date.now() + Math.random();
    const div = document.createElement('div');
    div.className = 'plan-rule-builder';
    div.dataset.ruleId = id;

    const actionNeedsValue = v => v === 'scale_budget' || v === 'reduce_budget';

    div.innerHTML = `
        <button class="btn-remove-rule" onclick="this.closest('.plan-rule-builder').remove()" title="Eliminar regla">✕</button>
        <div class="rule-builder-if">
            <span class="rule-badge-if">SI</span>
            <select class="rule-select rule-metric">
                ${Object.entries(METRICS).map(([k, v]) => `<option value="${k}" ${rule.metric === k ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
            <select class="rule-select rule-operator">
                ${Object.entries(OPERATORS).map(([k, v]) => `<option value="${k}" ${rule.operator === k ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
            <input class="rule-input rule-input-sm rule-threshold" type="number" step="0.01" min="0" value="${rule.threshold ?? ''}" placeholder="0" />
        </div>
        <div class="rule-builder-then">
            <span class="rule-badge-then">ENTONCES</span>
            <select class="rule-select rule-action">
                ${Object.entries(ACTIONS).map(([k, v]) => `<option value="${k}" ${rule.action === k ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
            <span class="rule-action-suffix" style="font-size:12px;color:var(--text-dim)">en</span>
            <input class="rule-input rule-input-sm rule-action-val" type="number" min="1" max="500" value="${rule.actionValue ?? 50}" placeholder="50" style="${actionNeedsValue(rule.action || 'scale_budget') ? '' : 'display:none'}" />
            <span class="rule-action-pct" style="font-size:12px;color:var(--text-dim);${actionNeedsValue(rule.action || 'scale_budget') ? '' : 'display:none'}">%</span>
        </div>
    `;

    // Show/hide % input based on action
    div.querySelector('.rule-action').addEventListener('change', function () {
        const show = actionNeedsValue(this.value);
        div.querySelector('.rule-action-suffix').style.display = show ? '' : 'none';
        div.querySelector('.rule-action-val').style.display = show ? '' : 'none';
        div.querySelector('.rule-action-pct').style.display = show ? '' : 'none';
    });

    $('planRulesContainer').appendChild(div);
}

function savePlan() {
    const name = $('planNameInput').value.trim();
    if (!name) { $('planNameInput').focus(); return; }

    const rules = [];
    document.querySelectorAll('.plan-rule-builder').forEach(row => {
        const metric = row.querySelector('.rule-metric').value;
        const operator = row.querySelector('.rule-operator').value;
        const threshold = parseFloat(row.querySelector('.rule-threshold').value);
        const action = row.querySelector('.rule-action').value;
        const actionValue = parseFloat(row.querySelector('.rule-action-val').value) || 50;
        if (!isNaN(threshold)) rules.push({ metric, operator, threshold, action, actionValue });
    });

    if (!rules.length) { showToast('Añade al menos una regla'); return; }

    const platform = $('planPlatformInput').value || 'meta';
    const list = loadPlans();
    if (editingPlanId) {
        const idx = list.findIndex(p => p.id === editingPlanId);
        if (idx >= 0) list[idx] = { ...list[idx], name, platform, rules };
    } else {
        list.unshift({ id: Date.now(), name, platform, rules, createdAt: new Date().toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' }), lastRun: null });
    }
    persistPlans(list);
    closePlanModal();
    renderPlans();
}

function renderPlans() {
    const list = loadPlans();
    const container = $('scalingPlansList');
    if (!container) return;

    if (!list.length) {
        container.innerHTML = `<p class="scaling-empty">No hay planes. Crea uno con el botón de arriba.</p>`;
        return;
    }

    container.innerHTML = list.map(plan => {
        const rulesHtml = plan.rules.map(r => {
            const metricLabel = METRICS[r.metric] || r.metric;
            const opLabel = OPERATORS[r.operator] || r.operator;
            const actionLabel = ACTIONS[r.action] || r.action;
            const actionSuffix = (r.action === 'scale_budget' || r.action === 'reduce_budget') ? ` ${r.actionValue}%` : '';
            return `<div class="plan-rule-row">
                <span class="rule-if">SI</span>
                <span class="rule-condition">${metricLabel} ${opLabel} <strong>${r.threshold}</strong></span>
                <span style="color:var(--text-dim)">→</span>
                <span class="rule-then">ENTONCES</span>
                <span class="rule-action">${actionLabel}${actionSuffix}</span>
            </div>`;
        }).join('');

        const platformIcon = { meta: '📘', google: '🔵', tiktok: '🎵' }[plan.platform || 'meta'] || '📘';
        const platformLabel = { meta: 'Meta', google: 'Google', tiktok: 'TikTok' }[plan.platform || 'meta'] || 'Meta';

        return `<div class="plan-card" data-plan-id="${plan.id}">
            <div class="plan-card-header">
                <div>
                    <div class="plan-card-name">${plan.name} <span class="plan-platform-badge">${platformIcon} ${platformLabel}</span></div>
                    <div class="plan-card-meta">${plan.rules.length} regla${plan.rules.length !== 1 ? 's' : ''} · Creado ${plan.createdAt}${plan.lastRun ? ` · Ejecutado ${plan.lastRun}` : ''}</div>
                </div>
                <div class="plan-card-actions">
                    <button class="btn-run-plan" onclick="window.runPlan(${plan.id})" title="Ejecutar sobre la campaña seleccionada">▶ Ejecutar</button>
                    <button class="btn-edit-plan" onclick="window.editPlan(${plan.id})">✏</button>
                    <button class="btn-delete-plan" onclick="window.deletePlan(${plan.id})">🗑</button>
                </div>
            </div>
            <div class="plan-rules-preview">${rulesHtml}</div>
            <div class="plan-run-result hidden" id="planResult_${plan.id}"></div>
        </div>`;
    }).join('');
}

window.editPlan = function (id) {
    const plan = loadPlans().find(p => p.id === id);
    if (plan) openPlanModal(plan);
};

window.deletePlan = function (id) {
    persistPlans(loadPlans().filter(p => p.id !== id));
    renderPlans();
};

window.runPlan = async function (id) {
    const campaignId = $('campaignSelector')?.value;
    if (!campaignId) { showToast('Selecciona primero una campaña en el dashboard'); return; }

    const plan = loadPlans().find(p => p.id === id);
    if (!plan) return;

    const platform = plan.platform || 'meta';
    const btn = document.querySelector(`.plan-card[data-plan-id="${id}"] .btn-run-plan`);
    const resultEl = $(`planResult_${id}`);

    // Validate platform matches campaign
    const campaign = state.campaigns.find(c => c.id === campaignId);
    if (campaign && campaign.platform && campaign.platform !== platform) {
        showToast(`Este plan es para ${platform.toUpperCase()} pero la campaña seleccionada es de ${(campaign.platform).toUpperCase()}`);
        return;
    }

    // Google and TikTok endpoints coming soon
    if (platform !== 'meta') {
        if (resultEl) {
            resultEl.innerHTML = `⏳ Planes de escalado para <strong>${platform}</strong> — próximamente`;
            resultEl.classList.remove('hidden');
        }
        showToast(`Escalado automático para ${platform} próximamente`);
        return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Ejecutando...'; }

    try {
        const res = await fetch('/api/meta-scaling-plan', {
            method: 'POST',
            headers: metaHeaders(),
            body: JSON.stringify({ campaignId, rules: plan.rules })
        });
        const data = await res.json();
        if (checkTokenExpired(data)) {
            if (resultEl) { resultEl.innerHTML = '❌ Token de Meta expirado — renuévalo en Configuración'; resultEl.classList.remove('hidden'); }
            return;
        }
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        // Update lastRun
        const list = loadPlans();
        const idx = list.findIndex(p => p.id === id);
        if (idx >= 0) { list[idx].lastRun = new Date().toLocaleDateString('es', { day: '2-digit', month: 'short' }); persistPlans(list); }

        const applied = data.applied || [];
        const resultText = applied.length
            ? applied.map(a => `✅ ${a.adName}: ${a.action}`).join('<br>')
            : '— Ningún anuncio cumplió las condiciones';

        if (resultEl) {
            resultEl.innerHTML = `<strong>Resultado:</strong><br>${resultText}`;
            resultEl.classList.remove('hidden');
        }
        renderPlans();
    } catch (err) {
        if (resultEl) { resultEl.innerHTML = `❌ ${err.message}`; resultEl.classList.remove('hidden'); }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '▶ Ejecutar'; }
    }
};

function showToast(msg) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1e1e3a;border:1px solid rgba(99,102,241,0.4);color:#fff;padding:10px 20px;border-radius:10px;font-size:13px;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,0.4)';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}

// ── Brand URL Analyzer ─────────────────────────────────────
async function analyzeBrandUrl() {
    const url = $('brandUrlInput')?.value?.trim();
    if (!url) { showStatus('brandAnalyzeStatus', '⚠️ Introduce la URL de tu marca', 'warning'); return; }

    const btn = $('btnAnalyzeBrandUrl');
    btn.disabled = true;
    btn.textContent = '⏳ Analizando...';
    showStatus('brandAnalyzeStatus', 'La IA está leyendo tu sitio web...', 'info');

    try {
        const res = await fetch('/api/brand-analyze', {
            method: 'POST',
            headers: aiHeaders(),
            body: JSON.stringify({ url })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        const p = data.brandProfile;
        if ($('b1')) $('b1').value = p.product || '';
        if ($('b2')) $('b2').value = p.audience || '';
        if ($('b3')) $('b3').value = p.painPoint || '';
        if ($('b4')) $('b4').value = p.differentiator || '';
        if (p.tone) {
            document.querySelectorAll('.tone-btn').forEach(btn => {
                const match = p.tone.toLowerCase().includes(btn.dataset.tone?.split(' ')[0]);
                if (match) { btn.click(); }
            });
        }
        showStatus('brandAnalyzeStatus', `✅ Briefing generado desde ${data.websiteTitle || url}`, 'success');
        setTimeout(() => hideStatus('brandAnalyzeStatus'), 4000);
    } catch (err) {
        showStatus('brandAnalyzeStatus', `❌ ${err.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '🔍 Analizar Marca';
    }
}

// ── Script Modal ────────────────────────────────────────────
let _scriptConceptIndex = null;
let _scriptDuration = 30;

async function openScriptModal(index) {
    _scriptConceptIndex = index;
    _scriptDuration = 30;
    document.querySelectorAll('.script-dur-tab').forEach(t => t.classList.toggle('active', +t.dataset.dur === 30));
    $('scriptContent').innerHTML = '';
    hideStatus('scriptModalStatus');
    $('modal-script').classList.remove('hidden');
    await _generateScript();
}

async function _generateScript() {
    if (_scriptConceptIndex === null) return;
    const c = state.concepts[_scriptConceptIndex];
    showStatus('scriptModalStatus', '⏳ Generando script de vídeo...', 'info');
    $('scriptContent').innerHTML = '';
    try {
        const res = await fetch('/api/generate-script', {
            method: 'POST',
            headers: aiHeaders(),
            body: JSON.stringify({ concept: c, briefing: state.briefing, duration: _scriptDuration })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        hideStatus('scriptModalStatus');
        $('scriptContent').innerHTML = `<pre class="script-pre">${data.script}</pre>`;
    } catch (err) {
        showStatus('scriptModalStatus', `❌ ${err.message}`, 'error');
    }
}

// ── Landing Page Modal ──────────────────────────────────────
let _landingConceptIndex = null;
let _landingPageType = 'product';
let _landingHtml = '';

async function openLandingModal(index) {
    _landingConceptIndex = index;
    _landingPageType = 'product';
    _landingHtml = '';
    document.querySelectorAll('.landing-type-tab').forEach(t => t.classList.toggle('active', t.dataset.type === 'product'));
    $('landingPreview').classList.add('hidden');
    hideStatus('landingModalStatus');
    $('modal-landing').classList.remove('hidden');
    await _generateLanding();
}

async function _generateLanding() {
    if (_landingConceptIndex === null) return;
    const c = state.concepts[_landingConceptIndex];
    showStatus('landingModalStatus', '⏳ Generando landing page...', 'info');
    $('landingPreview').classList.add('hidden');
    try {
        const res = await fetch('/api/generate-landing-page', {
            method: 'POST',
            headers: aiHeaders(),
            body: JSON.stringify({
                briefing: state.briefing,
                pageType: _landingPageType,
                concept: c,
                funnelStage: c.funnelStage || 'tofu'
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        _landingHtml = data.html;
        hideStatus('landingModalStatus');
        const preview = $('landingPreview');
        preview.srcdoc = _landingHtml;
        preview.classList.remove('hidden');
    } catch (err) {
        showStatus('landingModalStatus', `❌ ${err.message}`, 'error');
    }
}

function downloadHtml(html, filename) {
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
}

// ── Full Strategy Modal ─────────────────────────────────────
let _strategyData = null;
let _strategyStage = 'tofu';

async function generateFullStrategy() {
    if (!state.briefing) {
        showToast('Primero genera conceptos desde el Briefing');
        return;
    }
    $('modal-strategy').classList.remove('hidden');
    $('strategyContent').innerHTML = '';
    showStatus('strategyModalStatus', '⏳ Generando estrategia TOFU/MOFU/BOFU...', 'info');
    document.querySelectorAll('.strategy-tab').forEach(t => t.classList.toggle('active', t.dataset.stage === 'tofu'));
    _strategyStage = 'tofu';

    try {
        const res = await fetch('/api/campaign-strategy', {
            method: 'POST',
            headers: aiHeaders(),
            body: JSON.stringify({ briefing: state.briefing })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        _strategyData = data.strategy;
        hideStatus('strategyModalStatus');
        renderStrategyContent('tofu');
    } catch (err) {
        showStatus('strategyModalStatus', `❌ ${err.message}`, 'error');
    }
}

function renderStrategyContent(stage) {
    if (!_strategyData) return;
    const content = $('strategyContent');

    if (stage === 'budget') {
        const b = _strategyData.budgetAllocation || {};
        content.innerHTML = `
            <div class="strategy-budget-grid">
                <div class="strategy-budget-item"><span class="budget-label">Presupuesto diario total</span><span class="budget-value">${b.daily || '—'}</span></div>
                <div class="strategy-budget-item tofu-color"><span class="budget-label">🔵 TOFU (60%)</span><span class="budget-value">${b.tofu || '—'}</span></div>
                <div class="strategy-budget-item mofu-color"><span class="budget-label">🟠 MOFU (30%)</span><span class="budget-value">${b.mofu || '—'}</span></div>
                <div class="strategy-budget-item bofu-color"><span class="budget-label">🔴 BOFU (10%)</span><span class="budget-value">${b.bofu || '—'}</span></div>
            </div>
            ${_strategyData.testingPlan ? `<div class="strategy-testing-plan"><h4>📋 Plan de Testing</h4><p>${_strategyData.testingPlan}</p></div>` : ''}
        `;
        return;
    }

    const section = _strategyData[stage];
    if (!section) return;
    const concepts = section.concepts || [];
    content.innerHTML = `
        <div class="strategy-section-meta">
            <span class="strategy-objetivo">${section.objetivo || ''}</span>
            <span class="strategy-presupuesto">Presupuesto: <strong>${section.presupuesto || ''}</strong></span>
            <span class="strategy-formato">Formato: ${section.formato || ''}</span>
        </div>
        <div class="strategy-concepts-list">
            ${concepts.map(c => `
                <div class="strategy-concept-card">
                    <div class="sc-angle">${c.angle}</div>
                    <div class="sc-hook">"${c.hook}"</div>
                    <div class="sc-headline">${c.headline}</div>
                    <div class="sc-body">${c.body}</div>
                    <div class="sc-footer">
                        <span class="sc-cta">${c.cta}</span>
                        <span class="sc-emotion">❤️ ${c.targetEmotion || ''}</span>
                        ${c.suggestedFormat ? `<span class="sc-format">📱 ${c.suggestedFormat}</span>` : ''}
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

// ── Boot ───────────────────────────────────────────────────
init();
initChat();
renderStrategies();
