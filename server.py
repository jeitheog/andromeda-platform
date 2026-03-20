#!/usr/bin/env python3
"""
Andromeda Platform — Servidor unificado
Combina: CSV Translator + Andromeda Ads + Creative Studio
"""

import base64
import hashlib
import hmac
import http.server
import json
import os
import re
import secrets
import sqlite3
import time
import urllib.parse
import urllib.request
import urllib.error
import uuid

PORT = int(os.environ.get('PORT', 8080))
SHOPIFY_API_VERSION = "2024-01"
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public')


def _load_env():
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, _, v = line.partition('=')
                    os.environ.setdefault(k.strip(), v.strip())

_load_env()

# ── Planes y límites ─────────────────────────────────────────────────────────
PLAN_LIMITS = {'free': 50, 'pro': 1000, 'enterprise': -1}  # -1 = ilimitado
PLAN_PRICES = {
    'pro': {'amount': 2900, 'currency': 'eur', 'label': 'Pro — €29/mes'},
    'enterprise': {'amount': 9900, 'currency': 'eur', 'label': 'Enterprise — €99/mes'},
}
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'platform.db')


# ── SQLite ───────────────────────────────────────────────────────────────────
def _get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def _init_db():
    with _get_db() as conn:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                salt TEXT NOT NULL,
                name TEXT DEFAULT '',
                plan TEXT DEFAULT 'free',
                status TEXT DEFAULT 'active',
                stripe_customer_id TEXT,
                stripe_subscription_id TEXT,
                usage_count INTEGER DEFAULT 0,
                usage_reset_date TEXT DEFAULT '',
                created_at TEXT,
                updated_at TEXT
            )
        ''')
        conn.commit()

def _reset_usage_if_new_month(user):
    today = time.strftime('%Y-%m-01')
    if user['usage_reset_date'] != today:
        with _get_db() as conn:
            conn.execute('UPDATE users SET usage_count=0, usage_reset_date=? WHERE id=?',
                         (today, user['id']))
            conn.commit()
        return 0
    return user['usage_count']

def _increment_usage(user_id):
    today = time.strftime('%Y-%m-01')
    with _get_db() as conn:
        conn.execute('''UPDATE users SET usage_count = usage_count + 1,
                        usage_reset_date = COALESCE(NULLIF(usage_reset_date,''), ?)
                        WHERE id=?''', (today, user_id))
        conn.commit()

def _stripe_request(endpoint, method='POST', data=None):
    secret_key = os.environ.get('STRIPE_SECRET_KEY', '')
    token = base64.b64encode(f'{secret_key}:'.encode()).decode()
    body = urllib.parse.urlencode(data).encode() if data else None
    req = urllib.request.Request(
        f'https://api.stripe.com/v1/{endpoint}',
        data=body,
        headers={'Authorization': f'Basic {token}', 'Content-Type': 'application/x-www-form-urlencoded'},
        method=method
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except: return e.code, {'error': {'message': str(e)}}


# ── JWT ─────────────────────────────────────────────────────────────────────
def _verify_password(password, stored_hash, salt):
    computed = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 100000).hex()
    return hmac.compare_digest(computed, stored_hash)

def _create_token(email, role, ttl=86400, extra=None):
    data = {'email': email, 'role': role, 'exp': int(time.time()) + ttl}
    if extra:
        data.update(extra)
    payload = json.dumps(data)
    payload_b64 = base64.urlsafe_b64encode(payload.encode()).rstrip(b'=').decode()
    secret = os.environ.get('SECRET_KEY', '')
    sig = hmac.new(secret.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}"

def _verify_token(token):
    try:
        payload_b64, sig = token.rsplit('.', 1)
        secret = os.environ.get('SECRET_KEY', '')
        expected = hmac.new(secret.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None
        padding = 4 - len(payload_b64) % 4
        if padding != 4:
            payload_b64 += '=' * padding
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        if payload.get('exp', 0) < time.time():
            return None
        return payload
    except Exception:
        return None


# ── AI Proxy (Anthropic / OpenAI) ───────────────────────────────────────────
def _call_ai(system, messages, max_tokens, headers):
    anthropic_key = headers.get('x-anthropic-key', '')
    openai_key = headers.get('x-openai-key', '')
    if not anthropic_key and not openai_key:
        raise ValueError('Configura tu clave de IA en Configuración → APIs de Inteligencia Artificial')
    if anthropic_key:
        return _call_anthropic(system, messages, max_tokens, anthropic_key)
    return _call_openai(system, messages, max_tokens, openai_key)

def _call_anthropic(system, messages, max_tokens, api_key):
    body = json.dumps({'model': 'claude-sonnet-4-6', 'max_tokens': max_tokens, 'system': system, 'messages': messages}).encode()
    req = urllib.request.Request('https://api.anthropic.com/v1/messages', data=body,
        headers={'x-api-key': api_key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=60) as resp:
        d = json.loads(resp.read().decode())
    return {'text': d['content'][0]['text'].strip(), 'provider': 'anthropic'}

def _call_openai(system, messages, max_tokens, api_key):
    oai_messages = [{'role': 'system', 'content': system}] + messages
    body = json.dumps({'model': 'gpt-4o', 'max_tokens': max_tokens, 'messages': oai_messages}).encode()
    req = urllib.request.Request('https://api.openai.com/v1/chat/completions', data=body,
        headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=60) as resp:
        d = json.loads(resp.read().decode())
    return {'text': d['choices'][0]['message']['content'].strip(), 'provider': 'openai'}


class AndromeadaPlatformHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
            "Content-Type, Authorization, x-anthropic-key, x-openai-key, "
            "x-meta-token, x-meta-account, x-meta-page, x-meta-library-token, "
            "x-google-token, x-google-customer, x-google-dev-token, "
            "x-tiktok-token, x-tiktok-advertiser, x-shopify-shop, x-shopify-token")

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == '/api/auth/verify':
            self._handle_verify()
        elif path == '/api/meta-stats.js':
            self._handle_meta_stats()
        elif path == '/api/user/profile':
            self._handle_user_profile_get()
        elif path == '/api/user/usage':
            self._handle_user_usage()
        elif path == '/api/stripe/portal':
            self._handle_stripe_portal()
        elif path == '/api/admin/users':
            self._handle_admin_list_users()
        else:
            super().do_GET()

    def do_PUT(self):
        path = self.path.split('?')[0]
        if path == '/api/user/profile':
            self._handle_user_profile_put()
        elif path.startswith('/api/admin/users/'):
            self._handle_admin_update_user(path.split('/')[-1])
        else:
            self.send_error(405, "Method not allowed")

    def do_DELETE(self):
        path = self.path.split('?')[0]
        if path.startswith('/api/admin/users/'):
            self._handle_admin_delete_user(path.split('/')[-1])
        else:
            self.send_error(405, "Method not allowed")

    def do_PATCH(self):
        if self.path == '/api/meta-optimize.js':
            self._handle_meta_optimize_apply()
        else:
            self.send_error(405, "Method not allowed")

    def do_POST(self):
        path = self.path.split('?')[0]
        routes = {
            '/api/auth/login': self._handle_login,
            '/api/auth/logout': self._handle_logout,
            '/api/user/register': self._handle_user_register,
            '/api/stripe/checkout': self._handle_stripe_checkout,
            '/api/stripe/webhook': self._handle_stripe_webhook,
            '/api/translate': self._handle_translate,
            '/api/tag': self._handle_tag,
            '/api/scraper': self._handle_scraper,
            '/api/shopify/test': self._handle_shopify_test,
            '/api/shopify/products': self._handle_shopify_create_product,
            '/api/brand-analyze.js': self._handle_brand_analyze,
            '/api/campaign-strategy.js': self._handle_campaign_strategy,
            '/api/generate-concepts.js': self._handle_generate_concepts,
            '/api/generate-creative.js': self._handle_generate_creative,
            '/api/generate-script.js': self._handle_generate_script,
            '/api/generate-landing-page.js': self._handle_generate_landing_page,
            '/api/claude-chat.js': self._handle_claude_chat,
            '/api/meta-validate.js': self._handle_meta_validate,
            '/api/meta-create-campaign.js': self._handle_meta_create_campaign,
            '/api/meta-optimize.js': self._handle_meta_optimize,
            '/api/meta-scaling-plan.js': self._handle_meta_scaling_plan,
            '/api/meta-upload-creative.js': self._handle_meta_upload_creative,
            '/api/google-validate.js': self._handle_google_validate,
            '/api/google-create-campaign.js': self._handle_google_create_campaign,
            '/api/tiktok-validate.js': self._handle_tiktok_validate,
            '/api/tiktok-create-campaign.js': self._handle_tiktok_create_campaign,
            '/api/shopify-products.js': self._handle_ads_shopify_products,
            '/api/shopify-product.js': self._handle_ads_shopify_product,
            '/api/shopify-analyze.js': self._handle_shopify_analyze,
            '/api/analyze-product.js': self._handle_shopify_analyze,
            '/api/research-extract.js': self._handle_research_extract,
        }
        handler = routes.get(path)
        if handler:
            handler()
        else:
            self.send_error(404, "Endpoint no encontrado")

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length).decode("utf-8")) if length else {}

    def _send_json(self, status, data):
        response = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def _hdrs(self):
        return {k.lower(): v for k, v in self.headers.items()}

    def _ai_route(self, system, prompt, max_tokens):
        try:
            result = _call_ai(system, [{'role': 'user', 'content': prompt}], max_tokens, self._hdrs())
            text = result['text']
            if '{' in text:
                return 200, json.loads(text[text.index('{'):])
            return 200, {'text': text}
        except ValueError as e:
            return 400, {'error': str(e)}
        except Exception as e:
            return 500, {'error': str(e)}

    # ── AUTH ─────────────────────────────────────────────────────────────────
    def _handle_login(self):
        body = self._read_json()
        email = body.get('email', '').strip().lower()
        password = body.get('password', '')
        admin_email = os.environ.get('ADMIN_EMAIL', '').strip().lower()
        admin_hash = os.environ.get('ADMIN_PASSWORD_HASH', '')
        admin_salt = os.environ.get('ADMIN_SALT', '')
        if not admin_email or not admin_hash or not admin_salt:
            self._send_json(500, {'success': False, 'error': 'Servidor no configurado'})
            return
        if email == admin_email and _verify_password(password, admin_hash, admin_salt):
            token = _create_token(email, 'admin')
            self._send_json(200, {'success': True, 'token': token,
                'user': {'email': email, 'name': 'Super Admin', 'plan': 'unlimited',
                         'role': 'admin', 'usage': 0, 'filesProcessed': 0,
                         'billingHistory': [], 'status': 'active'}})
        else:
            self._send_json(401, {'success': False, 'error': 'Credenciales incorrectas'})

    def _handle_logout(self):
        self._send_json(200, {'success': True})

    def _handle_verify(self):
        token = self.headers.get('Authorization', '').replace('Bearer ', '').strip()
        payload = _verify_token(token) if token else None
        if payload:
            self._send_json(200, {'success': True, 'role': payload['role'], 'email': payload['email']})
        else:
            self._send_json(401, {'success': False, 'error': 'Sesión inválida o expirada'})

    # ── TRANSLATE ────────────────────────────────────────────────────────────
    def _handle_translate(self):
        body = self._read_json()
        text = body.get('text', '').strip()
        sl = body.get('sl', 'auto').strip() or 'auto'
        tl = body.get('tl', '').strip()
        if not text or not tl:
            self._send_json(400, {'error': 'Faltan campos: text, tl'})
            return
        try:
            url = (f"https://translate.googleapis.com/translate_a/single"
                   f"?client=gtx&sl={urllib.parse.quote(sl)}&tl={urllib.parse.quote(tl)}"
                   f"&dt=t&q={urllib.parse.quote(text)}")
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode())
            if data and data[0]:
                translated = "".join(seg[0] for seg in data[0] if seg and seg[0])
                if translated:
                    self._send_json(200, {'translated': translated, 'source': 'google'})
                    return
        except Exception:
            pass
        try:
            url2 = f"https://api.mymemory.translated.net/get?q={urllib.parse.quote(text)}&langpair={urllib.parse.quote(sl + '|' + tl)}"
            with urllib.request.urlopen(url2, timeout=10) as resp:
                data2 = json.loads(resp.read().decode())
            if data2.get('responseStatus') == 200:
                t = data2.get('responseData', {}).get('translatedText', '')
                if t:
                    self._send_json(200, {'translated': t, 'source': 'mymemory'})
                    return
        except Exception:
            pass
        self._send_json(502, {'error': 'No se pudo traducir'})

    # ── TAG (Gemini) ─────────────────────────────────────────────────────────
    def _handle_tag(self):
        gemini_key = os.environ.get('GEMINI_API_KEY', '')
        if not gemini_key:
            self._send_json(500, {'error': 'GEMINI_API_KEY no configurada'})
            return
        body = self._read_json()
        title = (body.get('title') or '').strip()
        original_title = (body.get('original_title') or '').strip()
        body_html = (body.get('body_html') or '').strip()
        vendor = (body.get('vendor') or '').strip()
        handle = (body.get('handle') or '').strip()
        plain = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', body_html)).strip()[:800]
        brand_hint = f' La marca es "{vendor}".' if vendor else ''
        parts = []
        if handle: parts.append(f'Handle: {handle}')
        if original_title: parts.append(f'Título original: {original_title}')
        if title and title != original_title: parts.append(f'Título traducido: {title}')
        if plain: parts.append(f'Descripción: {plain}')
        prompt = (f'Eres experto en copywriting para tiendas premium.{brand_hint}\n\n'
                  f'{chr(10).join(parts)}\n\nResponde ÚNICAMENTE con JSON: {{"tag": "...", "title": "..."}}')
        gemini_url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={gemini_key}'
        gemini_body = json.dumps({'contents': [{'parts': [{'text': prompt}]}],
                                  'generationConfig': {'maxOutputTokens': 150, 'temperature': 0.1}}).encode()
        try:
            req = urllib.request.Request(gemini_url, data=gemini_body,
                                         headers={'Content-Type': 'application/json'}, method='POST')
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode())
            raw = data['candidates'][0]['content']['parts'][0]['text'].strip()
            raw = re.sub(r'^```[a-z]*\n?', '', raw).rstrip('`').strip()
            parsed = json.loads(raw)
            self._send_json(200, {'tag': str(parsed.get('tag', '')).strip()[:60],
                                  'title': str(parsed.get('title', '')).strip()[:120]})
        except Exception as e:
            self._send_json(500, {'error': str(e)})

    # ── SHOPIFY (CSV Translator) ──────────────────────────────────────────────
    def _shopify_req(self, store, token, method, endpoint, data=None):
        url = f"https://{store}/admin/api/{SHOPIFY_API_VERSION}/{endpoint}"
        headers = {"X-Shopify-Access-Token": token, "Content-Type": "application/json"}
        body = json.dumps(data, ensure_ascii=False).encode() if data is not None else None
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req) as resp:
                return resp.status, json.loads(resp.read().decode() or '{}')
        except urllib.error.HTTPError as e:
            try: return e.code, json.loads(e.read().decode())
            except: return e.code, {"error": str(e)}
        except urllib.error.URLError as e:
            return 0, {"error": str(e.reason)}

    def _handle_shopify_test(self):
        body = self._read_json()
        store = body.get('store', '').strip().replace("https://", "").replace("http://", "").rstrip("/")
        token = body.get('token', '').strip()
        if not store or not token:
            self._send_json(400, {"error": "Faltan campos: store, token"})
            return
        if not store.endswith(".myshopify.com"):
            store += ".myshopify.com"
        status, data = self._shopify_req(store, token, "GET", "shop.json")
        if status == 200:
            shop = data.get("shop", {})
            self._send_json(200, {"success": True, "shop": {
                "name": shop.get("name"), "domain": shop.get("domain"),
                "email": shop.get("email"), "plan": shop.get("plan_display_name")}})
        else:
            self._send_json(status or 500, {"success": False,
                                            "error": data.get("errors", data.get("error", "Error"))})

    @staticmethod
    def _norm(s):
        if not s: return ""
        s = s.strip()
        if s.startswith("//"): s = "https:" + s
        return s.split('?')[0].lower()

    def _handle_shopify_create_product(self):
        body = self._read_json()
        store = body.get("store", "").strip().replace("https://", "").replace("http://", "").rstrip("/")
        token = body.get("token", "").strip()
        product = body.get("product")
        if not store or not token or not product:
            self._send_json(400, {"error": "Faltan campos: store, token, product"})
            return
        if not store.endswith(".myshopify.com"):
            store += ".myshopify.com"
        images_list = product.get('images', [])
        image_norm_map = {self._norm(img.get('src')): i for i, img in enumerate(images_list)}
        v_to_img_idx = {}
        for i, v in enumerate(product.get('variants', [])):
            src = v.pop('_variant_image_src', '')
            if src:
                norm_src = self._norm(src)
                if norm_src in image_norm_map:
                    v_to_img_idx[i] = image_norm_map[norm_src]
                else:
                    new_idx = len(images_list)
                    images_list.append({'src': src})
                    image_norm_map[norm_src] = new_idx
                    v_to_img_idx[i] = new_idx
        product['images'] = images_list
        status, data = self._shopify_req(store, token, "POST", "products.json", {"product": product})
        if status == 201:
            created = data.get("product", {})
            product_id = created.get("id")
            created_images = created.get("images", [])
            created_variants = created.get("variants", [])
            for v_idx, img_idx in v_to_img_idx.items():
                if v_idx < len(created_variants) and img_idx < len(created_images):
                    vid = created_variants[v_idx]['id']
                    iid = created_images[img_idx]['id']
                    self._shopify_req(store, token, "PUT", f"variants/{vid}.json",
                                      {"variant": {"id": vid, "image_id": iid}})
                    time.sleep(0.4)
            self._send_json(201, {"success": True, "product": {
                "id": product_id, "title": created.get("title"),
                "variants_count": len(created_variants)}})
        else:
            self._send_json(status or 500, {"success": False,
                                            "error": data.get("errors", data.get("error", "Error"))})

    # ── SCRAPER ───────────────────────────────────────────────────────────────
    def _handle_scraper(self):
        body = self._read_json()
        raw_url = body.get("url", "").strip()
        if not raw_url:
            self._send_json(400, {"error": "Falta la URL de la tienda"})
            return
        store_url = raw_url.rstrip("/")
        if not store_url.startswith("http"):
            store_url = "https://" + store_url
        parsed = urllib.parse.urlparse(store_url)
        path = parsed.path.lower()
        store_base = f"{parsed.scheme}://{parsed.netloc}"
        headers = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
        all_products = []
        try:
            if "/products/" in path:
                parts = path.split("/")
                try:
                    p_idx = next(i for i, p in enumerate(parts) if p == "products")
                    handle = parts[p_idx + 1]
                    req = urllib.request.Request(f"{store_base}/products/{handle}.json", headers=headers)
                    with urllib.request.urlopen(req, timeout=10) as resp:
                        p = json.loads(resp.read().decode()).get("product")
                    if p:
                        all_products = [p]
                except Exception:
                    pass
            if not all_products:
                page = 1
                target_handle = path.split("/products/")[1].split("/")[0].split("?")[0] if "/products/" in path else None
                while True:
                    req = urllib.request.Request(f"{store_base}/products.json?limit=250&page={page}", headers=headers)
                    with urllib.request.urlopen(req, timeout=12) as resp:
                        products = json.loads(resp.read().decode()).get("products", [])
                    if not products:
                        break
                    if target_handle:
                        p = next((x for x in products if x.get('handle') == target_handle), None)
                        if p:
                            all_products = [p]
                            break
                    else:
                        all_products.extend(products)
                    if len(products) < 250 or page >= 20:
                        break
                    page += 1
        except urllib.error.HTTPError as e:
            self._send_json(e.code, {"error": f"Error {e.code} de la tienda"})
            return
        except Exception as e:
            self._send_json(502, {"error": f"Fallo de conexión: {str(e)}"})
            return
        self._send_json(200, {"products": all_products, "total": len(all_products)})

    # ── ANDROMEDA ADS — AI ROUTES ─────────────────────────────────────────────
    def _handle_brand_analyze(self):
        body = self._read_json()
        url = body.get('url', '')
        if not url:
            self._send_json(400, {'error': 'URL de la marca es obligatoria'})
            return
        full_url = url if url.startswith('http') else f'https://{url}'
        try:
            req = urllib.request.Request(full_url, headers={'User-Agent': 'Mozilla/5.0 (compatible; AndromeAds/1.0)'})
            with urllib.request.urlopen(req, timeout=10) as resp:
                html = resp.read().decode('utf-8', errors='ignore')
        except Exception as e:
            self._send_json(500, {'error': f'No se pudo acceder al sitio: {str(e)}'})
            return
        strip_tags = lambda s: re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', s)).strip()
        title_m = re.search(r'<title[^>]*>(.*?)</title>', html, re.I)
        meta_m = re.search(r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)', html, re.I)
        h1s = [strip_tags(m.group(1)) for m in re.finditer(r'<h1[^>]*>(.*?)</h1>', html, re.I | re.S)][:5]
        h2s = [strip_tags(m.group(1)) for m in re.finditer(r'<h2[^>]*>(.*?)</h2>', html, re.I | re.S)][:8]
        prices = re.findall(r'[\$€£]\s*(?:\d+[\.,]\d{2}|\d+)', html)[:10]
        summary = '\n'.join(filter(None, [
            f'URL: {full_url}',
            f'Título: {strip_tags(title_m.group(1)) if title_m else url}',
            f'Meta description: {meta_m.group(1)}' if meta_m else '',
            f'H1: {" | ".join(h1s)}' if h1s else '',
            f'H2: {" | ".join(h2s)}' if h2s else '',
            f'Precios: {", ".join(prices)}' if prices else '',
        ]))
        system = 'Eres experto en estrategia de marca y publicidad digital. Respondes ÚNICAMENTE con JSON válido.'
        prompt = (f'Analiza este sitio y extrae su identidad de marca.\n\nDATOS:\n{summary}\n\n'
                  f'JSON: {{"product":"...","audience":"...","painPoint":"...","differentiator":"...",'
                  f'"tone":"elegante|casual|atrevida|minimalista|divertida|empoderada",'
                  f'"priceRange":"...","voiceGuide":"...","copyExample":"...","category":"..."}}')
        try:
            result = _call_ai(system, [{'role': 'user', 'content': prompt}], 800, self._hdrs())
            text = result['text']
            brand_profile = json.loads(text[text.index('{'):])
            self._send_json(200, {'brandProfile': brand_profile,
                                  'websiteTitle': strip_tags(title_m.group(1)) if title_m else url,
                                  'url': full_url})
        except Exception as e:
            self._send_json(500, {'error': str(e)})

    def _handle_campaign_strategy(self):
        body = self._read_json()
        briefing = body.get('briefing', {})
        if not briefing.get('product'):
            self._send_json(400, {'error': 'Falta el briefing'})
            return
        competitor = f"\nINSIGHTS DE COMPETIDORES:\n{body['competitorInsights']}\n" if body.get('competitorInsights') else ''
        system = 'Eres Director de Marketing experto en Meta Ads. Respondes ÚNICAMENTE con JSON válido.'
        prompt = (f'BRIEFING:\n- Producto: {briefing["product"]}\n- Audiencia: {briefing.get("audience","")}\n'
                  f'- Dolor: {briefing.get("painPoint","")}\n- Diferenciador: {briefing.get("differentiator","")}\n'
                  f'- Tono: {briefing.get("tone","moderno")}\n{competitor}\n'
                  f'Crea estrategia TOFU/MOFU/BOFU con 3 TOFU, 2 MOFU, 2 BOFU. Incluye budgetAllocation, landingPageRecs y testingPlan.')
        status, data = self._ai_route(system, prompt, 3000)
        self._send_json(status, {'strategy': data} if status == 200 else data)

    def _handle_generate_concepts(self):
        body = self._read_json()
        briefing = body.get('briefing', {})
        if not briefing.get('product'):
            self._send_json(400, {'error': 'Falta el briefing'})
            return
        selected = body.get('selectedProduct')
        funnel = body.get('funnelStage', 'all')
        funnel_map = {
            'tofu': 'Genera conceptos AWARENESS: FOMO, Curiosidad, Educativo. NO menciones precios.',
            'mofu': 'Genera conceptos CONSIDERACIÓN: Prueba social, Transformación, Beneficios.',
            'bofu': 'Genera conceptos CONVERSIÓN: Urgencia, Oferta, Garantía. Menciona precio.',
            'all': 'Mezcla: 4 TOFU, 3 MOFU, 3 BOFU.'
        }
        product_section = (f'\nPRODUCTO: {selected["title"]} — ${selected["price"]}\n'
                           f'{selected.get("description","")[:300]}') if selected else ''
        system = 'Eres copywriter experto en publicidad digital. Respondes ÚNICAMENTE con JSON válido.'
        prompt = (f'BRIEFING:\n- Producto: {briefing["product"]}\n- Audiencia: {briefing.get("audience","")}\n'
                  f'- Dolor: {briefing.get("painPoint","")}\n- Diferenciador: {briefing.get("differentiator","")}\n'
                  f'- Tono: {briefing.get("tone","moderno")}\n{product_section}\n'
                  f'ESTRATEGIA: {funnel_map.get(funnel,"")}\n'
                  f'Genera 10 conceptos. JSON: {{"concepts":[{{"angle":"...","hook":"...","headline":"...",'
                  f'"body":"...","cta":"...","painPoint":"...","targetEmotion":"...","funnelStage":"tofu|mofu|bofu"}}]}}')
        status, data = self._ai_route(system, prompt, 2000)
        self._send_json(status, data)

    def _handle_generate_creative(self):
        body = self._read_json()
        mode = body.get('mode', 'generate')
        concept = body.get('concept', {})
        style = body.get('style', 'modern, clean, high-fashion editorial')
        image_b64 = body.get('imageBase64', '')
        selected = body.get('selectedProduct')
        api_key = self.headers.get('x-openai-key', '')
        if not api_key:
            self._send_json(500, {'error': 'Falta la clave de OpenAI. Añádela en Configuración'})
            return
        product_anchor = (f'PRODUCT: "{selected["title"]}" — ${selected["price"]}\n'
                          f'{selected.get("description","")[:300]}') if selected else ''
        prompt_text = (f'Professional fashion advertisement for Instagram/Facebook/TikTok.\n{product_anchor}\n'
                       f'Concept: {concept.get("angle","")} — {concept.get("hook","")}\n'
                       f'Headline: {concept.get("headline","")}\nStyle: {style}\n'
                       f'1080x1080px, high-end fashion ad aesthetic.')
        try:
            if mode == 'generate':
                req_body = json.dumps({'model': 'gpt-image-1', 'prompt': prompt_text,
                                       'n': 1, 'size': '1024x1024', 'quality': 'high'}).encode()
                req = urllib.request.Request('https://api.openai.com/v1/images/generations', data=req_body,
                    headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}, method='POST')
                with urllib.request.urlopen(req, timeout=120) as resp:
                    d = json.loads(resp.read().decode())
                self._send_json(200, {'b64': d['data'][0]['b64_json']})
            elif mode == 'manual' and image_b64:
                self._send_json(200, {'b64': image_b64})
            else:
                self._send_json(400, {'error': 'Modo no válido o imagen faltante'})
        except Exception as e:
            self._send_json(500, {'error': str(e)})

    def _handle_generate_script(self):
        body = self._read_json()
        concept = body.get('concept', {})
        briefing = body.get('briefing', {})
        duration = body.get('duration', 30)
        if not concept or not briefing.get('product'):
            self._send_json(400, {'error': 'Faltan concept y briefing'})
            return
        system = 'Eres guionista experto en publicidad digital de vídeo. Escribes scripts virales para Meta Ads y TikTok.'
        prompt = (f'Script de vídeo publicitario:\nÁngulo: {concept.get("angle","")}\n'
                  f'Hook: {concept.get("hook","")}\nTitular: {concept.get("headline","")}\n'
                  f'Producto: {briefing["product"]}\nAudiencia: {briefing.get("audience","")}\n'
                  f'Duración: {duration} segundos\n\n'
                  f'Formato markdown: HOOK (0-3s), PROBLEMA, SOLUCIÓN, PRUEBA SOCIAL, CTA.')
        try:
            result = _call_ai(system, [{'role': 'user', 'content': prompt}], 1500, self._hdrs())
            self._send_json(200, {'script': result['text'], 'duration': duration, 'concept': concept.get('angle', '')})
        except Exception as e:
            self._send_json(500, {'error': str(e)})

    def _handle_generate_landing_page(self):
        body = self._read_json()
        briefing = body.get('briefing', {})
        concept = body.get('concept', {})
        system = 'Eres experto en landing pages de alto rendimiento para e-commerce. Respondes con HTML completo.'
        prompt = (f'Landing page para:\nProducto: {briefing.get("product","")}\n'
                  f'Audiencia: {briefing.get("audience","")}\nÁngulo: {concept.get("angle","")}\n'
                  f'Hook: {concept.get("hook","")}\nTitular: {concept.get("headline","")}\n'
                  f'CTA: {concept.get("cta","Comprar ahora")}\n\nHTML completo con CSS inline, responsive.')
        try:
            result = _call_ai(system, [{'role': 'user', 'content': prompt}], 3000, self._hdrs())
            self._send_json(200, {'html': result['text']})
        except Exception as e:
            self._send_json(500, {'error': str(e)})

    def _handle_claude_chat(self):
        body = self._read_json()
        messages = body.get('messages', [])
        system_prompt = body.get('system', 'Eres un asistente de marketing digital experto.')
        try:
            result = _call_ai(system_prompt, messages, 1024, self._hdrs())
            self._send_json(200, {'text': result['text'], 'provider': result['provider']})
        except Exception as e:
            self._send_json(500, {'error': str(e)})

    # ── META ──────────────────────────────────────────────────────────────────
    def _meta_req(self, path, method='GET', body=None, token=None):
        url = f'https://graph.facebook.com/v19.0/{path}'
        if token and method == 'GET':
            sep = '&' if '?' in url else '?'
            url += f'{sep}access_token={token}'
        data = None
        if body is not None:
            payload = {**body, 'access_token': token} if token else body
            data = json.dumps(payload).encode()
        req = urllib.request.Request(url, data=data,
            headers={'Content-Type': 'application/json'} if data else {}, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            try: return json.loads(e.read().decode())
            except: return {'error': {'message': str(e), 'code': e.code}}

    def _handle_meta_validate(self):
        body = self._read_json()
        token = body.get('token', '')
        account_id = body.get('adAccountId', '')
        if not token or not account_id:
            self._send_json(400, {'error': 'Faltan token o adAccountId'})
            return
        account = account_id if account_id.startswith('act_') else f'act_{account_id}'
        d = self._meta_req(f'{account}?fields=name,account_status,currency', token=token)
        if d.get('error'):
            err = d['error']
            if err.get('code') == 190:
                self._send_json(401, {'error': err.get('error_user_msg', err.get('message', '')), 'tokenExpired': True})
            else:
                self._send_json(401, {'error': err.get('error_user_msg', err.get('message', ''))})
            return
        self._send_json(200, {'accountName': d.get('name'), 'currency': d.get('currency'), 'status': d.get('account_status')})

    def _handle_meta_create_campaign(self):
        body = self._read_json()
        token = self.headers.get('x-meta-token', '')
        raw_account = self.headers.get('x-meta-account', '')
        page_id = self.headers.get('x-meta-page', '')
        if not token or not raw_account:
            self._send_json(400, {'error': 'Faltan credenciales de Meta'})
            return
        account = raw_account if raw_account.startswith('act_') else f'act_{raw_account}'
        daily_budget_cents = round(body.get('dailyBudgetUsd', 5) * 100)
        destination_url = body.get('destinationUrl', '')
        targeting = body.get('targeting', {})
        concepts = body.get('concepts', [])
        try:
            campaign = self._meta_req(f'{account}/campaigns', 'POST', {
                'name': body.get('campaignName', 'Andromeda Campaign'),
                'objective': 'OUTCOME_TRAFFIC', 'status': 'PAUSED',
                'special_ad_categories': [], 'daily_budget': daily_budget_cents,
                'bid_strategy': 'LOWEST_COST_WITHOUT_CAP'
            }, token)
            if campaign.get('error'):
                raise Exception(campaign['error'].get('message', 'Error Meta'))
            ad_set_ids, ad_ids, warnings = [], [], []
            for concept in concepts:
                genders = [1] if targeting.get('gender') == '1' else [2] if targeting.get('gender') == '2' else []
                ad_set = self._meta_req(f'{account}/adsets', 'POST', {
                    'campaign_id': campaign['id'],
                    'name': f'AdSet_{concept.get("angle","")[:30]}',
                    'billing_event': 'IMPRESSIONS', 'optimization_goal': 'LINK_CLICKS',
                    'targeting': {
                        'geo_locations': {'countries': targeting.get('countries', ['ES'])},
                        'age_min': targeting.get('ageMin', 18), 'age_max': targeting.get('ageMax', 45),
                        **({'genders': genders} if genders else {})
                    }, 'status': 'PAUSED'
                }, token)
                if ad_set.get('error'):
                    continue
                ad_set_ids.append(ad_set['id'])
                if page_id:
                    creative = self._meta_req(f'{account}/adcreatives', 'POST', {
                        'name': f'Creative_{concept.get("angle","")[:30]}',
                        'object_story_spec': {'page_id': page_id, 'link_data': {
                            'message': f'{concept.get("headline","")}\n\n{concept.get("body","")}',
                            'link': destination_url,
                            'call_to_action': {'type': 'SHOP_NOW', 'value': {'link': destination_url}}
                        }}
                    }, token)
                    if not creative.get('error'):
                        ad = self._meta_req(f'{account}/ads', 'POST', {
                            'adset_id': ad_set['id'],
                            'name': f'Ad_{concept.get("angle","")[:30]}',
                            'creative': {'creative_id': creative['id']}, 'status': 'PAUSED'
                        }, token)
                        if not ad.get('error'):
                            ad_ids.append(ad['id'])
                        else:
                            warnings.append(f'Ad falló: {ad["error"].get("message","")}')
                    else:
                        warnings.append(f'Creative falló: {creative["error"].get("message","")}')
                else:
                    warnings.append('Sin Page ID: no se creó el anuncio.')
            self._send_json(200, {'campaignId': campaign['id'], 'adSetIds': ad_set_ids, 'adIds': ad_ids, 'warnings': warnings})
        except Exception as e:
            self._send_json(500, {'error': str(e)})

    def _handle_meta_stats(self):
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        token = self.headers.get('x-meta-token', '')
        campaign_id = params.get('campaignId', [''])[0]
        if not token or not campaign_id:
            self._send_json(400, {'error': 'Faltan token o campaignId'})
            return
        FIELDS = 'spend,impressions,clicks,ctr,cpm,actions,action_values,reach'
        try:
            camp = self._meta_req(f'{campaign_id}/insights?fields={FIELDS}&date_preset=last_7d', token=token)
            if camp.get('error'):
                err = camp['error']
                if err.get('code') == 190:
                    self._send_json(401, {'error': err.get('message', ''), 'tokenExpired': True})
                    return
                raise Exception(err.get('message', ''))
            ads_data = self._meta_req(f'{campaign_id}/ads?fields=id,name,insights{{{FIELDS}}}', token=token)
            ads = []
            for ad in (ads_data.get('data') or []):
                ins = (ad.get('insights', {}).get('data') or [{}])[0]
                spend = float(ins.get('spend', 0))
                revenue = next((float(a['value']) for a in (ins.get('action_values') or [])
                                if 'purchase' in a.get('action_type', '')), 0)
                roas = round(revenue / spend, 2) if spend > 0 and revenue > 0 else 0
                conversions = next((a['value'] for a in (ins.get('actions') or [])
                                    if 'purchase' in a.get('action_type', '')), 0)
                ads.append({'id': ad['id'], 'name': ad['name'], 'spend': ins.get('spend', '0'),
                            'impressions': ins.get('impressions', '0'), 'clicks': ins.get('clicks', '0'),
                            'ctr': ins.get('ctr', '0'), 'cpm': ins.get('cpm', '0'),
                            'conversions': conversions, 'roas': roas})
            total_spend = sum(float(a['spend']) for a in ads)
            total_imp = sum(int(a['impressions']) for a in ads)
            total_clicks = sum(int(a['clicks']) for a in ads)
            self._send_json(200, {'summary': {
                'spend': total_spend, 'impressions': total_imp, 'clicks': total_clicks,
                'ctr': round(total_clicks / total_imp * 100, 2) if total_imp > 0 else 0,
                'cpm': round(total_spend / total_imp * 1000, 2) if total_imp > 0 else 0,
                'conversions': sum(int(a['conversions']) for a in ads)
            }, 'ads': ads})
        except Exception as e:
            self._send_json(500, {'error': str(e)})

    def _handle_meta_optimize(self):
        body = self._read_json()
        stats = body.get('stats')
        if not stats:
            self._send_json(400, {'error': 'Faltan stats'})
            return
        briefing = body.get('briefing', {})
        ads_text = '\n'.join(f'- {a["name"]}: CTR {a.get("ctr","0")}%, ROAS {a.get("roas","0")}x'
                             for a in (stats.get('ads') or []))
        system = 'Eres experto Media Buyer de Meta Ads. Respondes ÚNICAMENTE con JSON válido.'
        prompt = (f'Analiza el rendimiento:\n{ads_text}\n\n'
                  f'Decide qué pausar (CTR<0.5% o ROAS<0.8), escalar (ROAS>1.5 o CTR>2%).\n'
                  f'JSON: {{"insights":"...","pause":["adId1"],"scale":[{{"adId":"adId3","newBudget":10}}],'
                  f'"copyTweaks":"...","winnerAngle":"..."}}')
        status, data = self._ai_route(system, prompt, 1000)
        self._send_json(status, data)

    def _handle_meta_optimize_apply(self):
        body = self._read_json()
        token = self.headers.get('x-meta-token', '')
        if not token:
            self._send_json(400, {'error': 'Falta token de Meta'})
            return
        errors = []
        for ad_id in body.get('pause', []):
            try:
                self._meta_req(str(ad_id), 'POST', {'status': 'PAUSED'}, token)
            except Exception as e:
                errors.append(f'Pause {ad_id}: {str(e)}')
        for item in body.get('scale', []):
            try:
                ad_data = self._meta_req(f'{item["adId"]}?fields=adset_id', token=token)
                if ad_data.get('adset_id'):
                    self._meta_req(str(ad_data['adset_id']), 'POST',
                                   {'daily_budget': round(item['newBudget'] * 100)}, token)
            except Exception as e:
                errors.append(f'Scale {item.get("adId","")}: {str(e)}')
        self._send_json(200, {'applied': True, 'errors': errors})

    def _handle_meta_scaling_plan(self):
        body = self._read_json()
        stats = body.get('stats', {})
        briefing = body.get('briefing', {})
        system = 'Eres experto en escalado de campañas Meta Ads. Respondes ÚNICAMENTE con JSON válido.'
        prompt = (f'Plan de escalado para:\nProducto: {briefing.get("product","")}\n'
                  f'Gasto actual: ${stats.get("summary",{}).get("spend",0)}\n'
                  f'Genera fases de escalado, presupuestos y estrategia en JSON.')
        status, data = self._ai_route(system, prompt, 1500)
        self._send_json(status, data)

    def _handle_meta_upload_creative(self):
        body = self._read_json()
        token = self.headers.get('x-meta-token', '')
        raw_account = self.headers.get('x-meta-account', '')
        account = raw_account if raw_account.startswith('act_') else f'act_{raw_account}'
        image_url = body.get('imageUrl', '')
        if not token or not account or not image_url:
            self._send_json(400, {'error': 'Faltan credenciales o imageUrl'})
            return
        try:
            d = self._meta_req(f'{account}/adimages', 'POST', {'url': image_url}, token)
            images = d.get('images', {})
            image_hash = list(images.values())[0].get('hash') if images else None
            self._send_json(200, {'imageHash': image_hash})
        except Exception as e:
            self._send_json(500, {'error': str(e)})

    # ── GOOGLE ────────────────────────────────────────────────────────────────
    def _handle_google_validate(self):
        body = self._read_json()
        customer_id = body.get('customerId', '').replace('-', '')
        dev_token = body.get('developerToken', '')
        access_token = body.get('accessToken', '')
        if not customer_id or not dev_token or not access_token:
            self._send_json(400, {'error': 'Faltan credenciales de Google Ads'})
            return
        try:
            req = urllib.request.Request(
                f'https://googleads.googleapis.com/v17/customers/{customer_id}'
                f'?fields=customer.descriptiveName,customer.currencyCode',
                headers={'Authorization': f'Bearer {access_token}', 'developer-token': dev_token})
            with urllib.request.urlopen(req, timeout=15) as resp:
                d = json.loads(resp.read().decode())
            self._send_json(200, {
                'accountName': d.get('customer', {}).get('descriptiveName', f'Customer {customer_id}'),
                'customerId': customer_id,
                'currency': d.get('customer', {}).get('currencyCode', 'USD')})
        except Exception as e:
            self._send_json(500, {'error': str(e)})

    def _handle_google_create_campaign(self):
        self._send_json(200, {'message': 'Google Ads campaign creation via Google Ads API'})

    # ── TIKTOK ────────────────────────────────────────────────────────────────
    def _handle_tiktok_validate(self):
        body = self._read_json()
        access_token = body.get('accessToken', '')
        advertiser_id = body.get('advertiserId', '')
        if not access_token or not advertiser_id:
            self._send_json(400, {'error': 'Faltan credenciales de TikTok Ads'})
            return
        try:
            req = urllib.request.Request(
                f'https://business-api.tiktok.com/open_api/v1.3/advertiser/info/'
                f'?advertiser_ids={urllib.parse.quote(json.dumps([advertiser_id]))}',
                headers={'Access-Token': access_token})
            with urllib.request.urlopen(req, timeout=15) as resp:
                d = json.loads(resp.read().decode())
            if d.get('code') != 0:
                raise Exception(d.get('message', f'TikTok error {d.get("code")}'))
            advertiser = (d.get('data', {}).get('list') or [{}])[0]
            self._send_json(200, {'accountName': advertiser.get('advertiser_name'),
                                  'advertiserId': advertiser_id,
                                  'currency': advertiser.get('currency'),
                                  'timezone': advertiser.get('timezone')})
        except Exception as e:
            self._send_json(500, {'error': str(e)})

    def _handle_tiktok_create_campaign(self):
        self._send_json(200, {'message': 'TikTok campaign creation via TikTok Ads API'})

    # ── SHOPIFY (Ads Module) ──────────────────────────────────────────────────
    def _handle_ads_shopify_products(self):
        body = self._read_json()
        shop = self.headers.get('x-shopify-shop', '') or body.get('shop', '')
        token = self.headers.get('x-shopify-token', '') or body.get('token', '')
        if not shop or not token:
            self._send_json(400, {'error': 'Faltan credenciales de Shopify'})
            return
        headers = {'X-Shopify-Access-Token': token, 'Content-Type': 'application/json'}
        next_url = f'https://{shop}/admin/api/2024-01/products.json?limit=250&fields=id,title,variants,images'
        all_products = []
        pages = 0
        try:
            while next_url and pages < 10:
                req = urllib.request.Request(next_url, headers=headers)
                with urllib.request.urlopen(req, timeout=15) as resp:
                    data = json.loads(resp.read().decode())
                    link_header = resp.headers.get('link', '')
                for p in data.get('products', []):
                    all_products.append({'id': p['id'], 'title': p['title'],
                                         'price': (p.get('variants') or [{}])[0].get('price', '0'),
                                         'image': (p.get('images') or [{}])[0].get('src')})
                m = re.search(r'<([^>]+)>;\s*rel="next"', link_header)
                next_url = m.group(1) if m else None
                pages += 1
            self._send_json(200, {'products': all_products, 'total': len(all_products)})
        except Exception as e:
            self._send_json(500, {'error': str(e)})

    def _handle_ads_shopify_product(self):
        body = self._read_json()
        shop = self.headers.get('x-shopify-shop', '') or body.get('shop', '')
        token = self.headers.get('x-shopify-token', '') or body.get('token', '')
        product_id = body.get('productId', '')
        if not shop or not token or not product_id:
            self._send_json(400, {'error': 'Faltan credenciales o productId'})
            return
        try:
            req = urllib.request.Request(
                f'https://{shop}/admin/api/2024-01/products/{product_id}.json',
                headers={'X-Shopify-Access-Token': token})
            with urllib.request.urlopen(req, timeout=15) as resp:
                p = json.loads(resp.read().decode()).get('product', {})
            self._send_json(200, {'id': p.get('id'), 'title': p.get('title'),
                                  'price': (p.get('variants') or [{}])[0].get('price', '0'),
                                  'description': p.get('body_html', ''),
                                  'image': (p.get('images') or [{}])[0].get('src'),
                                  'tags': p.get('tags', ''), 'type': p.get('product_type', '')})
        except Exception as e:
            self._send_json(500, {'error': str(e)})

    def _handle_shopify_analyze(self):
        body = self._read_json()
        product = body.get('product', {})
        if not product:
            self._send_json(400, {'error': 'Falta el producto'})
            return
        system = 'Eres experto en marketing de e-commerce. Respondes ÚNICAMENTE con JSON válido.'
        prompt = (f'Analiza este producto para crear anuncios:\nTítulo: {product.get("title","")}\n'
                  f'Precio: ${product.get("price","")}\nDescripción: {str(product.get("description",""))[:500]}\n\n'
                  f'JSON: {{"targetAudience":"...","mainBenefit":"...","painPoint":"...",'
                  f'"suggestedAngles":["..."],"competitiveAdvantage":"..."}}')
        status, data = self._ai_route(system, prompt, 800)
        self._send_json(status, data)

    def _handle_research_extract(self):
        body = self._read_json()
        url = body.get('url', '')
        if not url:
            self._send_json(400, {'error': 'URL de Meta Ad Library es obligatoria'})
            return
        brand_m = re.search(r'[?&]q=([^&]+)|([a-zA-Z0-9-]+)\.(com|es|net|co)', url)
        brand_name = urllib.parse.unquote(brand_m.group(1) or brand_m.group(2) or '').replace('_', ' ') if brand_m else 'Competidor Analizado'
        ads = [
            {'id': 'ad_001', 'type': 'image',
             'mediaUrl': 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=600&h=600&fit=crop',
             'body': 'Novedad exclusiva! Descubre la nueva colección.', 'headline': 'La colección más esperada',
             'cta': 'Shop Now', 'landingPage': '#', 'impressions': '10K-50K', 'funnelStage': 'tofu'},
            {'id': 'ad_002', 'type': 'image',
             'mediaUrl': 'https://images.unsplash.com/photo-1511556532299-8f662fc26c06?w=600&fit=crop',
             'body': 'Cambia tu estilo hoy. Oferta 2x1 limitada.', 'headline': 'Oferta limitada: 2x1',
             'cta': 'Aprovechar', 'landingPage': '#', 'impressions': '50K-200K', 'funnelStage': 'mofu'},
            {'id': 'ad_003', 'type': 'image',
             'mediaUrl': 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&h=600&fit=crop',
             'body': '+50.000 clientes satisfechos. Calidad premium.', 'headline': '+50.000 clientes confían',
             'cta': 'Ver producto', 'landingPage': '#', 'impressions': '5K-20K', 'funnelStage': 'bofu'},
        ]
        report = f'<h4>Reporte: {brand_name}</h4><ul><li><strong>Estrategia:</strong> Exclusividad y urgencia.</li></ul>'
        ai_key = self.headers.get('x-anthropic-key', '') or self.headers.get('x-openai-key', '')
        if ai_key:
            try:
                ads_text = '\n'.join(f'Anuncio {i+1}: "{a["body"]}" | Titular: "{a["headline"]}"' for i, a in enumerate(ads))
                result = _call_ai('Eres experto en análisis de publicidad digital.',
                                  [{'role': 'user', 'content': f'Analiza estos anuncios y genera reporte HTML:\n{ads_text}'}],
                                  600, self._hdrs())
                report = result['text']
            except Exception:
                pass
        self._send_json(200, {'competitor': brand_name[:50], 'ads': ads, 'funnels': 2, 'report': report, 'source': 'mock'})

    # ── AUTH helpers ─────────────────────────────────────────────────────────
    def _get_current_user(self):
        """Returns user row from DB if token valid, else None."""
        token = self.headers.get('Authorization', '').replace('Bearer ', '').strip()
        if not token:
            return None
        payload = _verify_token(token)
        if not payload:
            return None
        # Admin has no DB row — return synthetic object
        if payload.get('role') == 'admin':
            return {'id': 'admin', 'email': payload['email'], 'role': 'admin',
                    'plan': 'enterprise', 'status': 'active', 'name': 'Admin'}
        with _get_db() as conn:
            row = conn.execute('SELECT * FROM users WHERE id=? AND status=?',
                               (payload.get('user_id', ''), 'active')).fetchone()
        return dict(row) if row else None

    def _require_user(self):
        """Returns user or sends 401. Use: user = self._require_user(); if not user: return"""
        user = self._get_current_user()
        if not user:
            self._send_json(401, {'error': 'Autenticación requerida'})
        return user

    def _require_admin(self):
        user = self._get_current_user()
        if not user or user.get('role') != 'admin':
            self._send_json(403, {'error': 'Acceso denegado'})
            return None
        return user

    # ── USER REGISTER ─────────────────────────────────────────────────────────
    def _handle_user_register(self):
        body = self._read_json()
        email = body.get('email', '').strip().lower()
        password = body.get('password', '')
        name = body.get('name', '').strip()
        if not email or not password:
            self._send_json(400, {'error': 'Email y contraseña son obligatorios'})
            return
        if len(password) < 6:
            self._send_json(400, {'error': 'La contraseña debe tener al menos 6 caracteres'})
            return
        salt = secrets.token_hex(16)
        pwd_hash = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 100000).hex()
        user_id = str(uuid.uuid4())
        now = time.strftime('%Y-%m-%dT%H:%M:%SZ')
        try:
            with _get_db() as conn:
                conn.execute(
                    'INSERT INTO users (id,email,password_hash,salt,name,plan,status,usage_count,usage_reset_date,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                    (user_id, email, pwd_hash, salt, name, 'free', 'active', 0, time.strftime('%Y-%m-01'), now, now)
                )
                conn.commit()
        except sqlite3.IntegrityError:
            self._send_json(409, {'error': 'Ya existe una cuenta con ese email'})
            return
        token = _create_token(email, 'user', extra={'user_id': user_id})
        self._send_json(201, {
            'success': True, 'token': token,
            'user': {'id': user_id, 'email': email, 'name': name, 'plan': 'free', 'role': 'user'}
        })

    # ── LOGIN (extendido para usuarios normales) ───────────────────────────────
    def _handle_login(self):
        body = self._read_json()
        email = body.get('email', '').strip().lower()
        password = body.get('password', '')

        # 1. Intentar admin
        admin_email = os.environ.get('ADMIN_EMAIL', '').strip().lower()
        admin_hash = os.environ.get('ADMIN_PASSWORD_HASH', '')
        admin_salt = os.environ.get('ADMIN_SALT', '')
        if admin_email and email == admin_email and _verify_password(password, admin_hash, admin_salt):
            token = _create_token(email, 'admin')
            self._send_json(200, {'success': True, 'token': token,
                'user': {'email': email, 'name': 'Admin', 'plan': 'enterprise',
                         'role': 'admin', 'status': 'active'}})
            return

        # 2. Intentar usuario normal
        with _get_db() as conn:
            row = conn.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone()
        if not row:
            self._send_json(401, {'success': False, 'error': 'Credenciales incorrectas'})
            return
        user = dict(row)
        if user['status'] != 'active':
            self._send_json(403, {'success': False, 'error': 'Cuenta desactivada'})
            return
        if not _verify_password(password, user['password_hash'], user['salt']):
            self._send_json(401, {'success': False, 'error': 'Credenciales incorrectas'})
            return
        token = _create_token(email, 'user', extra={'user_id': user['id']})
        self._send_json(200, {'success': True, 'token': token,
            'user': {'id': user['id'], 'email': email, 'name': user['name'],
                     'plan': user['plan'], 'role': 'user', 'status': user['status']}})

    # ── USER PROFILE ──────────────────────────────────────────────────────────
    def _handle_user_profile_get(self):
        user = self._require_user()
        if not user:
            return
        self._send_json(200, {
            'id': user['id'], 'email': user['email'], 'name': user.get('name', ''),
            'plan': user['plan'], 'role': user.get('role', 'user'), 'status': user.get('status', 'active')
        })

    def _handle_user_profile_put(self):
        user = self._require_user()
        if not user:
            return
        if user.get('role') == 'admin':
            self._send_json(200, {'success': True})
            return
        body = self._read_json()
        name = body.get('name', '').strip()
        now = time.strftime('%Y-%m-%dT%H:%M:%SZ')
        with _get_db() as conn:
            conn.execute('UPDATE users SET name=?, updated_at=? WHERE id=?',
                         (name, now, user['id']))
            conn.commit()
        self._send_json(200, {'success': True, 'name': name})

    # ── USER USAGE ────────────────────────────────────────────────────────────
    def _handle_user_usage(self):
        user = self._require_user()
        if not user:
            return
        if user.get('role') == 'admin':
            self._send_json(200, {'used': 0, 'limit': -1, 'plan': 'enterprise',
                                  'resetDate': time.strftime('%Y-%m-01')})
            return
        used = _reset_usage_if_new_month(user)
        limit = PLAN_LIMITS.get(user['plan'], 50)
        self._send_json(200, {
            'used': used, 'limit': limit, 'plan': user['plan'],
            'resetDate': time.strftime('%Y-%m-01'),
            'unlimited': limit == -1
        })

    # ── STRIPE CHECKOUT ───────────────────────────────────────────────────────
    def _handle_stripe_checkout(self):
        user = self._require_user()
        if not user:
            return
        body = self._read_json()
        plan = body.get('plan', '')
        if plan not in PLAN_PRICES:
            self._send_json(400, {'error': 'Plan inválido'})
            return
        app_url = os.environ.get('APP_URL', f'http://localhost:{PORT}')
        price_id = os.environ.get(f'STRIPE_{plan.upper()}_PRICE_ID', '')
        if not price_id:
            self._send_json(500, {'error': f'STRIPE_{plan.upper()}_PRICE_ID no configurado'})
            return
        status, data = _stripe_request('checkout/sessions', data={
            'mode': 'subscription',
            'line_items[0][price]': price_id,
            'line_items[0][quantity]': '1',
            'success_url': f'{app_url}/dashboard/?upgraded=1',
            'cancel_url': f'{app_url}/dashboard/',
            'customer_email': user['email'],
            'metadata[user_id]': user['id'],
            'metadata[plan]': plan,
        })
        if status == 200:
            self._send_json(200, {'url': data['url']})
        else:
            self._send_json(status, {'error': data.get('error', {}).get('message', 'Error Stripe')})

    # ── STRIPE WEBHOOK ────────────────────────────────────────────────────────
    def _handle_stripe_webhook(self):
        length = int(self.headers.get('Content-Length', 0))
        payload = self.rfile.read(length)
        sig_header = self.headers.get('Stripe-Signature', '')
        webhook_secret = os.environ.get('STRIPE_WEBHOOK_SECRET', '')
        # Verify signature
        try:
            parts = {p.split('=')[0]: p.split('=')[1] for p in sig_header.split(',')}
            ts = parts.get('t', '')
            sig = parts.get('v1', '')
            signed = f'{ts}.'.encode() + payload
            expected = hmac.new(webhook_secret.encode(), signed, hashlib.sha256).hexdigest()
            if not hmac.compare_digest(sig, expected):
                self._send_json(400, {'error': 'Firma inválida'})
                return
        except Exception:
            self._send_json(400, {'error': 'Error verificando webhook'})
            return
        event = json.loads(payload.decode())
        etype = event.get('type', '')
        obj = event.get('data', {}).get('object', {})
        if etype in ('checkout.session.completed', 'customer.subscription.updated'):
            meta = obj.get('metadata', {})
            user_id = meta.get('user_id', '')
            plan = meta.get('plan', '')
            stripe_customer = obj.get('customer', '')
            stripe_sub = obj.get('subscription', obj.get('id', ''))
            if user_id and plan:
                now = time.strftime('%Y-%m-%dT%H:%M:%SZ')
                with _get_db() as conn:
                    conn.execute(
                        'UPDATE users SET plan=?, stripe_customer_id=?, stripe_subscription_id=?, updated_at=? WHERE id=?',
                        (plan, stripe_customer, stripe_sub, now, user_id)
                    )
                    conn.commit()
        elif etype == 'customer.subscription.deleted':
            stripe_sub = obj.get('id', '')
            if stripe_sub:
                now = time.strftime('%Y-%m-%dT%H:%M:%SZ')
                with _get_db() as conn:
                    conn.execute('UPDATE users SET plan=?, updated_at=? WHERE stripe_subscription_id=?',
                                 ('free', now, stripe_sub))
                    conn.commit()
        self._send_json(200, {'received': True})

    # ── STRIPE PORTAL ─────────────────────────────────────────────────────────
    def _handle_stripe_portal(self):
        user = self._require_user()
        if not user:
            return
        customer_id = user.get('stripe_customer_id', '')
        if not customer_id:
            self._send_json(400, {'error': 'No tienes suscripción activa'})
            return
        app_url = os.environ.get('APP_URL', f'http://localhost:{PORT}')
        status, data = _stripe_request('billing_portal/sessions', data={
            'customer': customer_id,
            'return_url': f'{app_url}/dashboard/',
        })
        if status == 200:
            self._send_json(200, {'url': data['url']})
        else:
            self._send_json(status, {'error': data.get('error', {}).get('message', 'Error Stripe')})

    # ── ADMIN — USUARIOS ──────────────────────────────────────────────────────
    def _handle_admin_list_users(self):
        if not self._require_admin():
            return
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        plan_filter = params.get('plan', [''])[0]
        status_filter = params.get('status', [''])[0]
        page = int(params.get('page', ['1'])[0])
        per_page = 20
        offset = (page - 1) * per_page
        query = 'SELECT id,email,name,plan,status,usage_count,usage_reset_date,created_at,stripe_subscription_id FROM users WHERE 1=1'
        args = []
        if plan_filter:
            query += ' AND plan=?'; args.append(plan_filter)
        if status_filter:
            query += ' AND status=?'; args.append(status_filter)
        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
        args += [per_page, offset]
        with _get_db() as conn:
            rows = conn.execute(query, args).fetchall()
            total = conn.execute('SELECT COUNT(*) FROM users').fetchone()[0]
        self._send_json(200, {
            'users': [dict(r) for r in rows],
            'total': total, 'page': page, 'per_page': per_page
        })

    def _handle_admin_update_user(self, user_id):
        if not self._require_admin():
            return
        body = self._read_json()
        allowed = {'plan', 'status', 'name'}
        updates = {k: v for k, v in body.items() if k in allowed}
        if not updates:
            self._send_json(400, {'error': 'Nada que actualizar'})
            return
        now = time.strftime('%Y-%m-%dT%H:%M:%SZ')
        set_clause = ', '.join(f'{k}=?' for k in updates)
        with _get_db() as conn:
            conn.execute(f'UPDATE users SET {set_clause}, updated_at=? WHERE id=?',
                         list(updates.values()) + [now, user_id])
            conn.commit()
        self._send_json(200, {'success': True})

    def _handle_admin_delete_user(self, user_id):
        if not self._require_admin():
            return
        now = time.strftime('%Y-%m-%dT%H:%M:%SZ')
        with _get_db() as conn:
            conn.execute('UPDATE users SET status=?, updated_at=? WHERE id=?',
                         ('inactive', now, user_id))
            conn.commit()
        self._send_json(200, {'success': True})

    def log_message(self, format, *args):
        if "/api/" in (args[0] if args else ""):
            super().log_message(format, *args)


def main():
    _init_db()
    print()
    print("  Andromeda Platform")
    print("  ─────────────────────────────────────────")
    print(f"  Servidor: http://localhost:{PORT}")
    print(f"  Modulos:  /translator | /ads | /studio | /dashboard | /admin/users")
    print()
    server = http.server.HTTPServer(("", PORT), AndromeadaPlatformHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Servidor detenido.")
        server.server_close()


if __name__ == "__main__":
    main()
