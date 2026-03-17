/* ============================================================
   CSV Traductor al Español — app.js
   ============================================================ */

// ── State ──────────────────────────────────────────────────
const state = {
  rawText: '',
  headers: [],
  rows: [],        // array of arrays
  selectedCols: new Set(),
  translatedRows: [],
  fileName: '',
  isShopify: false,
  scrapedProducts: [],
  selectedProducts: [], // scraped products chosen for translation
};

// ── Shopify Template Detection ─────────────────────────────
// Only these columns will be translated in a Shopify CSV.
// Supports BOTH the generic template format AND the real export format.
const SHOPIFY_TRANSLATABLE_COLS = new Set([
  'Title',
  'Description',        // generic template format
  'Body (HTML)',         // real export format
  'Body HTML',           // variation
  'Content',             // variation
  'Product Description', // variant
  'Long Description',    // variant
  'Image Alt Text',     // image descriptions
  'SEO Title',          // SEO title
  'SEO Description',    // SEO description
  'Option1 name',       // generic template (names)
  'Option2 name',
  'Option3 name',
  'Option1 Name',       // real export (names)
  'Option2 Name',
  'Option3 Name',
]);

const SHOPIFY_CLEARED_COLS = new Set([
  'Type',
  'Collections',        // generic template
  'Tags',               // generic template
  'Collection',         // variation
  'Custom Product Type', // real export
  'Standard Product Type' // real export
]);

// Keywords that identify a color option (case-insensitive)
const COLOR_KEYWORDS = ['color', 'colour', 'farbe', 'kleur', 'couleur', 'colore', 'cor', 'coloris', 'kulur', 'väri', 'farge', 'färg'];

function addColorOptionValues(headers, rows) {
  const extra = new Set();
  const normalizedHeaders = headers.map(h => h.toLowerCase());

  // 1. Direct detection: If a header IS a color keyword, treat it as translatable
  headers.forEach((h, idx) => {
    const hLow = h.toLowerCase();
    if (COLOR_KEYWORDS.some(k => hLow === k || hLow.includes(k + ' ') || hLow.includes(' ' + k))) {
      extra.add(h);
    }
  });

  // 2. Pair detection: Check OptionX Name -> OptionX Value
  const optionPairs = [
    ['option1 name', 'option1 value'],
    ['option2 name', 'option2 value'],
    ['option3 name', 'option3 value'],
  ];

  for (const [nameMatch, valueMatch] of optionPairs) {
    const nameIdx = normalizedHeaders.indexOf(nameMatch);
    const valueIdx = normalizedHeaders.indexOf(valueMatch);

    if (nameIdx >= 0 && valueIdx >= 0) {
      // Check first 10 rows for the option name value (e.g. "Color")
      for (let i = 0; i < Math.min(rows.length, 10); i++) {
        const val = (rows[i][nameIdx] || '').trim().toLowerCase();
        if (val && COLOR_KEYWORDS.some(k => val.includes(k))) {
          extra.add(headers[valueIdx]);
          break;
        }
      }
    }
  }
  return extra;
}

// Two signature sets: generic template vs real Shopify export
const SHOPIFY_SIGNATURE_TEMPLATE = ['URL handle', 'SKU', 'Fulfillment service', 'SEO title'];
const SHOPIFY_SIGNATURE_EXPORT = ['Handle', 'Variant SKU', 'Variant Inventory Policy', 'Variant Price'];

function isShopifyTemplate(headers) {
  const hSet = new Set(headers.map(h => h.trim().toLowerCase()));
  const shopifyKeys = ['handle', 'sku', 'price', 'body (html)', 'title', 'inventory', 'vendor', 'url handle', 'variant price', 'variant description'];

  let matches = 0;
  for (const k of shopifyKeys) {
    if (hSet.has(k)) matches++;
  }

  // If at least one match, we show the Shopify panel as an option.
  const isShopify = matches >= 1 || hSet.has('handle') || hSet.has('url handle');
  console.log(`Checking if Shopify: ${isShopify} (Matches: ${matches}, Headers: ${Array.from(hSet).join(', ')})`);
  return isShopify;
}

// ── DOM refs ───────────────────────────────────────────────
const $ = id => document.getElementById(id);

const dropZone = $('dropZone');
const fileInput = $('fileInput');
const browseBtn = $('browseBtn');
const fileInfo = $('fileInfo');
const fileNameEl = $('fileName');
const fileSizeEl = $('fileSize');
const removeFileBtn = $('removeFile');

const stepUpload = $('step-upload');
const stepConfigure = $('step-configure');
const stepProgress = $('step-progress');
const stepResult = $('step-result');

const sourceLang = $('sourceLang');
const columnsGrid = $('columnsGrid');
const selectAllBtn = $('selectAll');
const deselectAllBtn = $('deselectAll');
const selectedCount = $('selectedCount');
const previewTable = $('previewTable');

const translateBtn = $('translateBtn');
const progressText = $('progressText');
const progressPct = $('progressPercent');
const progressFill = $('progressFill');
const progressDetail = $('progressDetail');

const resultStats = $('resultStats');
const resultTable = $('resultTable');
const comparisonTable = $('comparisonTable');

const downloadBtn = $('downloadBtn');
const startOverBtn = $('startOverBtn');

// ── Shopify Scraper refs ────────────────────────────────────
const shopifyImportUrl = $('shopifyImportUrl');
const importFromUrlBtn = $('importFromUrlBtn');
const importStatus = $('importStatus');
const stepSelect = $('step-select');
const productsGrid = $('productsGrid');
const continueWithSelected = $('continueWithSelected');
const selectProductCountEl = $('selectProductCount');
const productSearchInput = $('productSearchInput');
const selectAllProductsBtn = $('selectAllProducts');
const deselectAllProductsBtn = $('deselectAllProducts');
const backToUploadBtn = $('backToUpload');

// ── File Upload ────────────────────────────────────────────
browseBtn.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('click', e => { if (e.target !== browseBtn) fileInput.click(); });

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.name.endsWith('.csv')) handleFile(file);
  else alert('Por favor sube un archivo .csv');
});

removeFileBtn.addEventListener('click', resetUpload);

function handleFile(file) {
  state.fileName = file.name;
  const reader = new FileReader();
  reader.onload = e => {
    state.rawText = e.target.result;
    parseCSV(state.rawText);
    showFileInfo(file);

    // If it's a Shopify file, show product selection first
    if (isShopifyTemplate(state.headers)) {
      const products = csvToProducts(state.headers, state.rows);

      // Feedback consistent with URL import
      importStatus.textContent = `✅ CSV procesado: ${products.length} productos encontrados`;
      importStatus.classList.remove('hidden');

      // Small delay for better UX (feedback visibility)
      setTimeout(() => {
        showProductSelect(products, true);
      }, 800);
    } else {
      showConfigStep();
    }
  };
  reader.readAsText(file, 'UTF-8');
}

function csvToProducts(headers, rows) {
  // Case-insensitive header matching
  const h = headers.map(v => (v || '').trim().toLowerCase());

  const findIdx = candidates => {
    for (const c of candidates) {
      const idx = h.indexOf(c.toLowerCase());
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const handleIdx = findIdx(['Handle', 'URL handle', 'handle', 'id']);
  const titleIdx = findIdx(['Title', 'title', 'nombre', 'product title']);
  const imgIdx = findIdx(['Image Src', 'image', 'imagen', 'img', 'variant image']);
  const priceIdx = findIdx(['Variant Price', 'price', 'precio', 'variant_price', 'amount']);

  const productsMap = new Map();

  rows.forEach(row => {
    const handle = (handleIdx >= 0 ? row[handleIdx] : (titleIdx >= 0 ? row[titleIdx] : '')) || '';
    const trimmedHandle = handle.trim();
    if (!trimmedHandle) return;

    if (!productsMap.has(trimmedHandle)) {
      productsMap.set(trimmedHandle, {
        handle: trimmedHandle,
        title: (titleIdx >= 0 ? row[titleIdx] : '') || trimmedHandle,
        images: imgIdx >= 0 && row[imgIdx] && row[imgIdx].toString().startsWith('http') ? [{ src: row[imgIdx] }] : [],
        variants: priceIdx >= 0 && row[priceIdx] ? [{ price: row[priceIdx].toString().replace(/[^0-9.]/g, '') }] : [],
        fromCSV: true
      });
    } else {
      const p = productsMap.get(trimmedHandle);
      if (!p.title && titleIdx >= 0 && row[titleIdx]) p.title = row[titleIdx];
      if (p.images.length === 0 && imgIdx >= 0 && row[imgIdx] && row[imgIdx].toString().startsWith('http')) p.images = [{ src: row[imgIdx] }];
      if (p.variants.length === 0 && priceIdx >= 0 && row[priceIdx]) p.variants = [{ price: row[priceIdx].toString().replace(/[^0-9.]/g, '') }];
    }
  });

  return Array.from(productsMap.values());
}

function showFileInfo(file) {
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = formatBytes(file.size);
  fileInfo.classList.remove('hidden');
  dropZone.classList.add('hidden');
}

function resetUpload() {
  fileInfo.classList.add('hidden');
  dropZone.classList.remove('hidden');
  fileInput.value = '';
  stepSelect.classList.add('hidden');
  stepConfigure.classList.add('hidden');
  stepProgress.classList.add('hidden');
  stepResult.classList.add('hidden');
  const sStep = $('shopifyStep');
  if (sStep) sStep.classList.add('hidden');
  importStatus.classList.add('hidden');
  importFromUrlBtn.disabled = false;
  state.rawText = '';
  state.headers = [];
  state.rows = [];
  state.selectedCols.clear();
  state.translatedRows = [];
  state.scrapedProducts = [];
}

// ── Shopify URL Importer ────────────────────────────────────
importFromUrlBtn.addEventListener('click', async () => {
  const url = shopifyImportUrl.value.trim();
  if (!url) return;

  importFromUrlBtn.disabled = true;
  importStatus.textContent = '⏳ Conectando con la tienda...';
  importStatus.classList.remove('hidden');

  try {
    const res = await fetch('/api/scraper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    let data;
    try { data = await res.json(); } catch { throw new Error(`Error del servidor (${res.status}). Verifica que la URL sea una tienda Shopify válida.`); }
    if (!res.ok) throw new Error(data.error || 'Error desconocido');

    if (!data.products || data.products.length === 0) {
      importStatus.textContent = '⚠️ No se encontraron productos en esa tienda.';
      importFromUrlBtn.disabled = false;
      return;
    }

    importStatus.textContent = `✅ ${data.total} productos encontrados`;
    state.scrapedProducts = data.products;
    showProductSelect(data.products);
  } catch (err) {
    importStatus.textContent = `❌ ${err.message}`;
    importFromUrlBtn.disabled = false;
  }
});

function showProductSelect(products, fromManualCSV = false) {
  stepUpload.classList.add('hidden');
  stepSelect.classList.remove('hidden');
  stepConfigure.classList.add('hidden');

  productsGrid.innerHTML = '';
  productSearchInput.value = '';
  const selected = new Set(products.map((_, i) => i));

  function updateCount() {
    selectProductCountEl.textContent = `${selected.size} seleccionados`;
    continueWithSelected.disabled = selected.size === 0;
  }

  products.forEach((p, i) => {
    const img = (p.images && p.images[0]) ? p.images[0].src : '';
    const price = p.variants && p.variants[0] ? `€${p.variants[0].price}` : '';
    const card = document.createElement('div');
    card.className = 'product-card selected';
    card.dataset.index = i;
    card.dataset.title = p.title.toLowerCase();
    card.innerHTML = `
      <input type="checkbox" checked />
      ${img ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(p.title)}" loading="lazy" />` : '<div style="width:100%;aspect-ratio:1;background:rgba(255,255,255,0.08);border-radius:8px;"></div>'}
      <p class="product-title">${escapeHtml(p.title)}</p>
      <p class="product-price">${escapeHtml(price)}</p>
    `;
    card.addEventListener('click', () => {
      const cb = card.querySelector('input[type="checkbox"]');
      if (selected.has(i)) {
        selected.delete(i);
        card.classList.remove('selected');
        cb.checked = false;
      } else {
        selected.add(i);
        card.classList.add('selected');
        cb.checked = true;
      }
      updateCount();
    });
    productsGrid.appendChild(card);
  });

  updateCount();

  // ── Search filter ──
  productSearchInput.oninput = () => {
    const q = productSearchInput.value.trim().toLowerCase();
    productsGrid.querySelectorAll('.product-card').forEach(c => {
      c.style.display = (!q || c.dataset.title.includes(q)) ? '' : 'none';
    });
  };

  // ── Select / deselect only visible cards ──
  selectAllProductsBtn.onclick = () => {
    productsGrid.querySelectorAll('.product-card').forEach(c => {
      if (c.style.display === 'none') return;
      const idx = parseInt(c.dataset.index);
      selected.add(idx);
      c.classList.add('selected');
      c.querySelector('input').checked = true;
    });
    updateCount();
  };

  deselectAllProductsBtn.onclick = () => {
    productsGrid.querySelectorAll('.product-card').forEach(c => {
      if (c.style.display === 'none') return;
      const idx = parseInt(c.dataset.index);
      selected.delete(idx);
      c.classList.remove('selected');
      c.querySelector('input').checked = false;
    });
    updateCount();
  };

  backToUploadBtn.onclick = () => {
    stepSelect.classList.add('hidden');
    stepUpload.classList.remove('hidden');
    importFromUrlBtn.disabled = false;
  };

  continueWithSelected.onclick = () => {
    const selectedIndices = Array.from(selected);
    const selectedProducts = products.filter((_, i) => selected.has(i));
    const selectedHandles = new Set(selectedProducts.map(p => p.handle));

    state.selectedProducts = selectedProducts;  // keep for direct Shopify import

    if (fromManualCSV) {
      // Filter the original rows by handles
      const handleIdx = state.headers.indexOf('Handle') >= 0 ? state.headers.indexOf('Handle') : state.headers.indexOf('URL handle');
      state.rows = state.rows.filter(row => selectedHandles.has((row[handleIdx] || '').trim()));
    } else {
      // Standard scraper flow: build CSV from objects
      const csvText = productsToCSV(selectedProducts);
      state.fileName = `${shopifyImportUrl.value.trim().replace(/https?:\/\//, '')}-productos.csv`;
      parseCSV(csvText);
    }

    stepSelect.classList.add('hidden');
    showConfigStep();
  };
}

function productsToCSV(products) {
  const headers = [
    'Handle', 'Title', 'Body (HTML)', 'Vendor', 'Type', 'Tags', 'Published',
    'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value', 'Option3 Name', 'Option3 Value',
    'Variant SKU', 'Variant Grams', 'Variant Inventory Tracker', 'Variant Inventory Qty',
    'Variant Inventory Policy', 'Variant Fulfillment Service', 'Variant Price',
    'Variant Compare At Price', 'Variant Requires Shipping', 'Variant Taxable', 'Variant Barcode',
    'Image Src', 'Image Alt Text', 'Gift Card', 'SEO Title', 'SEO Description', 'Variant Weight Unit',
    'Variant Image',
  ];

  const escapeCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

  const rows = [headers.map(escapeCell).join(',')];

  for (const p of products) {
    const variants = p.variants || [];
    const options = p.options || [];
    const images = p.images || [];
    const tags = Array.isArray(p.tags) ? p.tags.join(', ') : (p.tags || '');

    // Build a set of image srcs claimed by variant featured_images
    const variantImageSrcs = new Set(
      variants.map(v => v.featured_image && v.featured_image.src).filter(Boolean)
    );

    const firstImg = images[0] || {};

    variants.forEach((v, i) => {
      const isFirst = i === 0;
      // Prefer featured_image; fall back to searching product.images by variant_ids
      const variantImgSrc = v.featured_image
        ? (v.featured_image.src || '')
        : (images.find(img => Array.isArray(img.variant_ids) && img.variant_ids.includes(v.id))?.src || '');

      rows.push([
        p.handle,
        isFirst ? p.title : '',
        isFirst ? (p.body_html || '') : '',
        isFirst ? (p.vendor || '') : '',
        isFirst ? (p.product_type || '') : '',
        isFirst ? tags : '',
        isFirst ? (p.published_at ? 'true' : 'false') : '',
        isFirst ? (options[0] ? options[0].name : '') : '',
        v.option1 || '',
        isFirst ? (options[1] ? options[1].name : '') : '',
        v.option2 || '',
        isFirst ? (options[2] ? options[2].name : '') : '',
        v.option3 || '',
        v.sku || '',
        v.grams || '',
        '',                                     // Force 'Inventory not tracked' (empty Tracker)
        '',                                     // No quantity for untracked items
        'continue',                             // Force 'Continue selling' (comprar indefinida)
        v.fulfillment_service || 'manual',
        v.price || '',
        v.compare_at_price || '',
        v.requires_shipping ?? '',
        v.taxable ?? '',
        v.barcode || '',
        isFirst ? (firstImg.src || '') : '',   // Image Src: main product image, first row only
        isFirst ? (firstImg.alt || '') : '',   // Image Alt Text
        'false',
        isFirst ? (p.title || '') : '',
        '',
        v.weight_unit || 'kg',
        variantImgSrc,                          // Variant Image: per-variant image on every row
      ].map(escapeCell).join(','));
    });

    // Image-only rows: product images not already covered by Image Src or Variant Image
    const usedSrcs = new Set([firstImg.src, ...variantImageSrcs].filter(Boolean));
    const productImages = images.filter(img => img.src && !usedSrcs.has(img.src));

    for (const img of productImages) {
      if (!img.src) continue;
      rows.push(headers.map(h => {
        if (h === 'Handle') return escapeCell(p.handle);
        if (h === 'Image Src') return escapeCell(img.src);
        if (h === 'Image Alt Text') return escapeCell(img.alt || '');
        return '""';
      }).join(','));
    }
  }

  return rows.join('\n');
}

// ── CSV Parsing ────────────────────────────────────────────
function parseCSV(text) {
  // RFC 4180-compliant parser: handles multi-line quoted fields, escaped quotes, etc.
  const rows = [];
  let current = '';
  let inQuotes = false;
  let row = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          // Escaped quote ""
          current += '"';
          i += 2;
        } else {
          // End of quoted field
          inQuotes = false;
          i++;
        }
      } else {
        current += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ',') {
        row.push(current);
        current = '';
        i++;
      } else if (ch === '\r') {
        // Handle \r\n or standalone \r
        row.push(current);
        current = '';
        rows.push(row);
        row = [];
        i++;
        if (i < text.length && text[i] === '\n') i++;
      } else if (ch === '\n') {
        row.push(current);
        current = '';
        rows.push(row);
        row = [];
        i++;
      } else {
        current += ch;
        i++;
      }
    }
  }

  // Push last field and row
  if (current || row.length > 0) {
    row.push(current);
    rows.push(row);
  }

  // Filter out empty rows
  const filtered = rows.filter(r => r.length > 1 || (r.length === 1 && r[0].trim() !== ''));

  if (filtered.length === 0) return;

  state.headers = filtered[0];
  state.rows = filtered.slice(1);

  // Ensure all rows have the same number of columns as headers
  const colCount = state.headers.length;
  state.rows = state.rows.map(r => {
    if (r.length < colCount) {
      // Pad with empty strings
      return [...r, ...new Array(colCount - r.length).fill('')];
    } else if (r.length > colCount) {
      // Trim excess
      return r.slice(0, colCount);
    }
    return r;
  });

  console.log(`CSV parsed: ${state.headers.length} columns, ${state.rows.length} rows`);
}

// ── Configure Step ─────────────────────────────────────────
function showConfigStep() {
  state.isShopify = isShopifyTemplate(state.headers);

  // Calculate statistics
  const totalVariants = state.rows.length;
  let uniqueProducts = 0;

  const handleIdx = state.headers.indexOf('Handle');
  const titleIdx = state.headers.indexOf('Title');

  if (handleIdx >= 0) {
    const handles = new Set(state.rows.map(r => r[handleIdx]).filter(h => h && h.trim()));
    uniqueProducts = handles.size;
  } else if (titleIdx >= 0) {
    const titles = new Set(state.rows.map(r => r[titleIdx]).filter(t => t && t.trim()));
    uniqueProducts = titles.size;
  } else {
    uniqueProducts = totalVariants; // Fallback
  }

  // Update Stats UI
  const productEl = document.getElementById('countProducts');
  const variantEl = document.getElementById('countVariants');
  if (productEl) productEl.textContent = uniqueProducts;
  if (variantEl) variantEl.textContent = totalVariants;


  // Show or hide the Shopify info banner
  let banner = $('shopifyBanner');
  if (state.isShopify) {
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'shopifyBanner';
      banner.className = 'shopify-banner';
      banner.innerHTML = `
        <span class="shopify-icon">🛍️</span>
        <div>
          <strong>Plantilla de Shopify detectada</strong>
          <p>Solo se traducirán: <em>Title, Description, y nombres de opciones (Farbe→Color, Größe→Talla)</em>. Los valores y demás campos se mantienen intactos.</p>
        </div>
      `;
      stepConfigure.insertBefore(banner, stepConfigure.querySelector('.config-row'));
    }
    // Also show the connection panel earlier if it's Shopify
    const panel = $('shopifyImportPanel');
    if (panel) panel.style.display = 'block';
  } else {
    if (banner) banner.remove();
  }

  stepConfigure.classList.remove('hidden');
  if (state.isShopify) {
    const sStep = $('shopifyStep');
    if (sStep) sStep.classList.remove('hidden');
  }
  buildColumnsGrid();
}

function buildColumnsGrid() {
  columnsGrid.innerHTML = '';
  state.selectedCols.clear();

  // Dynamically add color option value columns
  const colorCols = state.isShopify ? addColorOptionValues(state.headers, state.rows) : new Set();

  // Case-insensitive check for Shopify translatable columns
  const normalizedTranslatable = new Set(Array.from(SHOPIFY_TRANSLATABLE_COLS).map(c => c.toLowerCase()));
  const normalizedColorCols = new Set(Array.from(colorCols).map(c => c.toLowerCase()));

  state.headers.forEach((header, idx) => {
    const hLower = header.toLowerCase();
    const shouldTranslate = state.isShopify
      ? (normalizedTranslatable.has(hLower) || normalizedColorCols.has(hLower)) // Shopify: text + color fields
      : true;                                    // Generic: all columns by default

    const shouldClearByDefault = state.isShopify && SHOPIFY_CLEARED_COLS.has(header);

    const chip = document.createElement('label');
    chip.className = 'col-chip';
    if (shouldTranslate && !shouldClearByDefault) chip.classList.add('selected');
    chip.dataset.idx = idx;

    // In Shopify mode, lock non-translatable columns visually (unless they are cleared columns or identified color columns)
    const isActuallyTranslatable = normalizedTranslatable.has(hLower) || normalizedColorCols.has(hLower);
    const locked = state.isShopify && !isActuallyTranslatable && !shouldClearByDefault;
    if (locked) chip.classList.add('locked');

    let recommendTag = '';
    if (shouldTranslate && !shouldClearByDefault) {
      recommendTag = ' <small style="color:var(--accent);opacity:0.8;font-weight:600;">(recomendada)</small>';
    } else if (shouldClearByDefault) {
      recommendTag = ' <small style="color:#ef4444;opacity:0.9;font-weight:600;">(borrado recomendado)</small>';
    }

    const isChecked = shouldTranslate && !shouldClearByDefault;
    chip.innerHTML = `<input type="checkbox" ${isChecked ? 'checked' : ''} /><span class="check">${isChecked ? '✓' : ''}</span> ${escapeHtml(header)}${recommendTag}`;

    if (!locked) {
      chip.addEventListener('click', () => toggleCol(chip, idx));
    }

    columnsGrid.appendChild(chip);
    if (isChecked) state.selectedCols.add(idx);
  });

  updateSelectionCounter();
}

function updateSelectionCounter() {
  if (selectedCount) {
    const count = state.selectedCols.size;
    selectedCount.textContent = `${count} ${count === 1 ? 'seleccionada' : 'seleccionadas'}`;
  }
}

function toggleCol(chip, idx) {
  if (state.selectedCols.has(idx)) {
    state.selectedCols.delete(idx);
    chip.classList.remove('selected');
    chip.querySelector('.check').textContent = '';
    chip.querySelector('input').checked = false;
  } else {
    state.selectedCols.add(idx);
    chip.classList.add('selected');
    chip.querySelector('.check').textContent = '✓';
    chip.querySelector('input').checked = true;
  }
  updateSelectionCounter();
}

selectAllBtn.addEventListener('click', () => {
  document.querySelectorAll('.col-chip').forEach((chip) => {
    const idx = parseInt(chip.dataset.idx);
    state.selectedCols.add(idx);
    chip.classList.add('selected');
    chip.querySelector('.check').textContent = '✓';
    chip.querySelector('input').checked = true;
  });
  updateSelectionCounter();
});

deselectAllBtn.addEventListener('click', () => {
  document.querySelectorAll('.col-chip').forEach(chip => {
    chip.classList.remove('selected');
    chip.querySelector('.check').textContent = '';
    chip.querySelector('input').checked = false;
  });
  state.selectedCols.clear();
  updateSelectionCounter();
});


// ── Title Paraphrasing Engine ──────────────────────────────
const brandNameInput = document.getElementById('brandName');

const SYNONYMS = {
  // Clothing types
  'polo': ['camiseta polo', 'polo deportivo', 'polo clásico', 'polo casual'],
  'camiseta': ['remera', 'playera', 'top', 'camiseta casual'],
  'camisa': ['blusa', 'camisa elegante', 'camisa de vestir'],
  'pantalón': ['pantalones', 'jeans', 'vaqueros'],
  'pantalones': ['pantalón', 'jeans', 'vaqueros'],
  'chaqueta': ['cazadora', 'chamarra', 'abrigo ligero', 'jacket'],
  'sudadera': ['hoodie', 'suéter', 'jersey'],
  'vestido': ['traje', 'atuendo', 'prenda elegante'],
  'zapatos': ['calzado', 'zapatillas'],
  'zapatillas': ['tenis', 'sneakers', 'zapatos deportivos'],

  // Descriptors
  'ultra': ['súper', 'extra', 'máxima', 'extremadamente'],
  'cómodo': ['confortable', 'suave al tacto', 'de gran comodidad', 'ergonómico'],
  'cómoda': ['confortable', 'suave', 'de gran comodidad'],
  'elegante': ['sofisticado', 'distinguido', 'refinado', 'con estilo'],
  'moderno': ['contemporáneo', 'actual', 'de última tendencia', 'vanguardista'],
  'moderna': ['contemporánea', 'actual', 'de última tendencia'],
  'clásico': ['atemporal', 'tradicional', 'de estilo eterno'],
  'clásica': ['atemporal', 'tradicional', 'de estilo eterno'],
  'premium': ['de alta gama', 'de lujo', 'de primera calidad', 'exclusivo'],
  'ligero': ['liviano', 'ultraligero', 'de peso pluma'],
  'ligera': ['liviana', 'ultraligera', 'de peso pluma'],
  'suave': ['aterciopelado', 'delicado', 'sedoso'],
  'casual': ['informal', 'desenfadado', 'relajado', 'de uso diario'],
  'deportivo': ['atlético', 'sport', 'para actividades'],
  'deportiva': ['atlética', 'sport', 'para actividades'],
  'resistente': ['duradero', 'robusto', 'de alta resistencia'],
  'ajustado': ['entallado', 'slim fit', 'de corte ceñido'],
  'ajustada': ['entallada', 'slim fit', 'de corte ceñido'],
  'transpirable': ['ventilado', 'de alta ventilación', 'fresh'],
  'increíble': ['asombroso', 'extraordinario', 'fantástico', 'impresionante'],

  // Target audience
  'hombre': ['caballero', 'él', 'hombre moderno'],
  'hombres': ['caballeros', 'ellos'],
  'mujer': ['dama', 'ella', 'mujer moderna'],
  'mujeres': ['damas', 'ellas'],
  'niño': ['chico', 'pequeño'],
  'niños': ['chicos', 'pequeños'],

  // Prepositions & connectors
  'para': ['ideal para', 'diseñado para', 'pensado para', 'perfecto para'],
};

// ── AI-Style Brand Name Generator ──────────────────────────
// Generates unique, premium-sounding brand names using syllable combinations

async function enhanceTitle(translatedTitle, originalTitle, handle, bodyHtml, vendor) {
  // 1. Try AI-powered enhancement via Gemini
  try {
    const res = await fetch('/api/tag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: translatedTitle,
        original_title: originalTitle,
        handle: handle,
        body_html: bodyHtml,
        vendor: vendor
      }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.title) return data.title;
    }
  } catch (e) {
    console.warn('AI Title Enhancement failed, falling back to heuristic.', e);
  }

  // 2. Fallback: Detect what kind of product this is from the translated title (Heuristic)
  const lower = translatedTitle.toLowerCase();

  // Detect garment type
  let garment = '';
  const GARMENT_KEYWORDS = [
    { keys: ['polo'], label: 'Polo' },
    { keys: ['camiseta', 'remera', 'playera', 't-shirt'], label: 'Camiseta' },
    { keys: ['camisa', 'shirt', 'blusa'], label: 'Camisa' },
    { keys: ['sudadera', 'hoodie', 'suéter', 'jersey'], label: 'Sudadera' },
    { keys: ['chaqueta', 'jacket', 'cazadora'], label: 'Chaqueta' },
    { keys: ['pantalón', 'pantalones', 'pants', 'jean'], label: 'Pantalón' },
    { keys: ['shorts', 'bermuda', 'corto'], label: 'Shorts' },
    { keys: ['vestido', 'dress'], label: 'Vestido' },
    { keys: ['falda', 'skirt'], label: 'Falda' },
    { keys: ['abrigo', 'coat'], label: 'Abrigo' },
    { keys: ['chaleco', 'vest'], label: 'Chaleco' },
    { keys: ['zapato', 'shoe', 'zapatilla', 'sneaker'], label: 'Zapatillas' },
    { keys: ['bolso', 'bag', 'mochila'], label: 'Bolso' },
    { keys: ['gorro', 'hat', 'gorra'], label: 'Gorro' },
    { keys: ['seguro', 'versicher', 'insurance', 'prioridad', 'versand'], label: '' },
  ];
  for (const g of GARMENT_KEYWORDS) {
    if (g.keys.some(k => lower.includes(k))) {
      garment = g.label;
      break;
    }
  }
  if (!garment) garment = 'Producto';

  // Detect audience
  let audience = '';
  if (lower.includes('hombre') || lower.includes('caballero') || lower.includes('männer') || lower.includes('herren') || lower.includes(' men') || lower.includes(' him')) {
    audience = 'para Hombre';
  } else if (lower.includes('mujer') || lower.includes('dama') || lower.includes('frauen') || lower.includes('damen') || lower.includes('women') || lower.includes(' her')) {
    audience = 'para Mujer';
  } else if (lower.includes('niño') || lower.includes('kinder') || lower.includes('kids')) {
    audience = 'para Niño';
  } else if (lower.includes('unisex')) {
    audience = 'Unisex';
  }

  // Random Spanish adjectives for product names
  const ADJECTIVES = [
    'Elegante', 'Sofisticado', 'Clásico', 'Premium', 'Moderno',
    'Exclusivo', 'Esencial', 'Sublime', 'Refinado', 'Atemporal',
    'Versátil', 'Dinámico', 'Impecable', 'Distinguido', 'Audaz',
    'Contemporáneo', 'Icónico', 'Vanguardista', 'Minimalista', 'Urbano',
  ];

  // Random style/collection words
  const STYLES = [
    'Edición Selecta', 'Colección Esencia', 'Línea Signature', 'Serie Elite',
    'Corte Italiano', 'Diseño Continental', 'Estilo Mediterráneo', 'Acabado Fino',
    'Tejido Superior', 'Comfort Fit', 'Slim Fit', 'Toque Suave',
    'Alta Costura', 'Edición Limitada', 'Colección Cápsula', 'Línea Premium',
    'Detalle Artesanal', 'Fibra Natural', 'Textura Deluxe', 'Corte Perfecto',
  ];

  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const style = STYLES[Math.floor(Math.random() * STYLES.length)];

  // Name patterns (Enforce: [Tag] - [Catchy Detail])
  const PATTERNS = [
    () => `${garment} - ${adj} ${audience}`.trim(),
    () => `${garment} - ${style} ${audience}`.trim(),
    () => `${garment} - ${adj} · ${style}`,
    () => `${garment} - ${style} ${adj}`,
  ];

  const pattern = PATTERNS[Math.floor(Math.random() * PATTERNS.length)];
  return pattern();
}

// ── Translation ────────────────────────────────────────────

translateBtn.addEventListener('click', startTranslation);

async function startTranslation() {
  if (state.selectedCols.size === 0) {
    alert('Selecciona al menos una columna para traducir.');
    return;
  }

  const rowsToProcess = state.rows;
  const skippedRows = 0;

  stepConfigure.classList.add('hidden');
  stepProgress.classList.remove('hidden');

  // Show/reset verification panel
  const verifyPanel = $('verificationPanel');
  if (verifyPanel) {
    verifyPanel.classList.remove('hidden');
    $('verifySuccess').textContent = '0';
    $('verifyFailed').textContent = '0';
    $('verifyRetrying').textContent = '';
  }

  const lang = sourceLang.value;
  const langPair = lang === 'auto' ? 'auto|es' : `${lang}|es`;

  console.log(`🚀 Iniciando traducción con par: ${langPair}`);

  // Collect all texts to translate (only first MAX_PRODUCTS rows)
  const textsToTranslate = [];
  const cellMap = []; // { rowIdx, colIdx, textIdx }

  rowsToProcess.forEach((row, rowIdx) => {
    state.headers.forEach((_, colIdx) => {
      if (state.selectedCols.has(colIdx)) {
        const text = (row[colIdx] || '').trim();
        if (text) {
          textsToTranslate.push(text);
          cellMap.push({ rowIdx, colIdx, textIdx: textsToTranslate.length - 1 });
        }
      }
    });
  });

  // Deep clone ALL rows (untouched rows beyond MAX_PRODUCTS keep original values)
  state.translatedRows = state.rows.map(r => [...r]);

  const total = textsToTranslate.length;
  let done = 0;
  let successCount = 0;
  let failedCells = []; // { idx, rowIdx, colIdx, originalText }

  updateProgress(0, total, 'Iniciando traducción...', 0, 0);

  const BATCH_SIZE = 5;
  const DELAY_MS = 250;

  // Find indices for enhancement context
  const titleIdx = state.headers.indexOf('Title');
  const bodyIdx = state.headers.indexOf('Body (HTML)');
  const vendorIdx = state.headers.indexOf('Vendor');
  const handleIdx = state.headers.indexOf('Handle') >= 0
    ? state.headers.indexOf('Handle')
    : state.headers.indexOf('URL handle');
  const enhancedTitles = {};

  // Helper: check if text is "untranslatable" (number, URL, code, etc.)
  function isSkippable(text) {
    if (!text || text.trim() === '') return true;
    if (/^\d+([.,]\d+)?$/.test(text.trim())) return true;
    if (/^https?:\/\//i.test(text.trim())) return true;
    if (/^[A-Z0-9_\-]+$/i.test(text.trim()) && text.trim().length < 8) return true; // Only skip very short SKUs/codes
    return false;
  }

  // ── Main translation pass ──
  for (let i = 0; i < textsToTranslate.length; i += BATCH_SIZE) {
    const batch = textsToTranslate.slice(i, i + BATCH_SIZE);
    const batchCells = cellMap.slice(i, i + BATCH_SIZE);

    const translations = await Promise.all(
      batch.map(text => translateText(text, langPair))
    );

    for (let j = 0; j < translations.length; j++) {
      const translated = translations[j];
      const { rowIdx, colIdx } = batchCells[j];
      const originalText = batch[j];

      // Verify: did translation actually change the text?
      const didTranslate = translated !== null && translated !== originalText;
      // Never skip translating titles
      const skippable = (colIdx === titleIdx) ? false : isSkippable(originalText);

      if (translated === null) {
        // Explicit failure — keep original, mark for retry
        state.translatedRows[rowIdx][colIdx] = originalText;
        failedCells.push({ idx: i + j, rowIdx, colIdx, originalText });
      } else if (!didTranslate && !skippable && originalText.length > 3) {
        // Returned same text but it's not a code/number — suspect failure
        state.translatedRows[rowIdx][colIdx] = originalText;
        failedCells.push({ idx: i + j, rowIdx, colIdx, originalText });
      } else {
        // Success path
        state.translatedRows[rowIdx][colIdx] = translated;
        successCount++;
      }
      done++;
    }

    updateProgress(done, total, `Traduciendo celda ${done} de ${total}...`, successCount, failedCells.length);

    if (i + BATCH_SIZE < textsToTranslate.length) {
      await sleep(DELAY_MS);
    }
  }

  // ── Retry pass for failed cells ──
  if (failedCells.length > 0) {
    if (verifyPanel) $('verifyRetrying').textContent = `🔄 Reintentando ${failedCells.length} celdas...`;
    updateProgress(done, total, `🔄 Reintentando ${failedCells.length} celdas fallidas...`, successCount, failedCells.length);

    await sleep(2000); // long pause before retry

    const retryResults = [];
    for (let k = 0; k < failedCells.length; k++) {
      const cell = failedCells[k];
      const retried = await translateText(cell.originalText, langPair);

      const didWork = retried !== null && retried !== cell.originalText;
      if (didWork) {
        state.translatedRows[cell.rowIdx][cell.colIdx] = retried;
        successCount++;
        retryResults.push(true);
      } else {
        retryResults.push(false);
      }

      updateProgress(done, total,
        `🔄 Reintento ${k + 1} de ${failedCells.length}...`,
        successCount, failedCells.length - retryResults.filter(r => r).length
      );

      await sleep(800); // slower retry pace
    }

    // Update failed count after retries
    const stillFailed = retryResults.filter(r => !r).length;
    failedCells = failedCells.filter((_, i) => !retryResults[i]);

    if (verifyPanel) {
      $('verifyRetrying').textContent = stillFailed > 0
        ? `⚠️ ${stillFailed} celdas no pudieron ser traducidas`
        : '✅ ¡Todos los reintentos exitosos!';
    }
  }

  // Final verification update
  const finalFailed = failedCells.length;
  updateProgress(total, total, '¡Traducción completada!', successCount, finalFailed);


  showResult(total, successCount, finalFailed, skippedRows);
}

async function translateText(text, langPair, retries = 3) {
  if (!text || text.trim() === '') return text;

  // Skip purely numeric values
  if (/^\d+([.,]\d+)?$/.test(text.trim())) return text;

  // Skip URLs
  if (/^https?:\/\//i.test(text.trim())) return text;

  // If text contains HTML tags, translate only the text parts
  if (/<[^>]+>/.test(text)) {
    return translateHTML(text, langPair, retries);
  }

  const result = await translatePlainText(text, langPair, retries);
  return result; // null = failure, string = success
}

// Translate HTML content: preserve tags, translate only text between them
async function translateHTML(html, langPair, retries) {
  // Split into HTML tags and text segments
  const parts = html.split(/(<[^>]*>)/g);
  const textSegments = [];
  const textIndices = [];

  // Identify segments that need translation
  parts.forEach((part, idx) => {
    if (part && !/^<[^>]*>$/.test(part) && part.trim() !== '') {
      textSegments.push(part);
      textIndices.push(idx);
    }
  });

  if (textSegments.length === 0) return html;

  // Batch translate segments using a unique delimiter
  // We use characters that Google Translate usually preserves
  const delimiter = " [[[###]]] ";
  const fullText = textSegments.join(delimiter);
  const translatedBody = await translatePlainText(fullText, langPair, retries);

  // If translation failed entirely, return null to signal failure
  if (translatedBody === null) return null;

  // Split with regex to be flexible with spaces (Google might add/remove spaces around symbols)
  const translatedSegments = translatedBody.split(/\s*\[\[\[###\]\]\]\s*/).map(s => s.trim());

  // VERIFICATION: Did we get the same number of segments back?
  if (translatedSegments.length === textSegments.length) {
    textIndices.forEach((partIdx, i) => {
      parts[partIdx] = translatedSegments[i];
    });
    return parts.join('');
  } else {
    // FALLBACK: If batching failed (mangled delimiters), translate segments one by one
    console.warn(`HTML Batch mismatch (${translatedSegments.length} vs ${textSegments.length}). Falling back to individual segments.`);

    // We do this in parallel but with a slight delay between to avoid rate limiting
    const results = [];
    for (const seg of textSegments) {
      const trans = await translatePlainText(seg, langPair, retries);
      results.push(trans || seg); // fallback to original if individual fails
      await sleep(100);
    }

    textIndices.forEach((partIdx, i) => {
      parts[partIdx] = results[i];
    });
    return parts.join('');
  }
}

// Translate plain text via server-side proxy (/api/translate) with browser fallbacks
async function translatePlainText(text, langPair, retries = 3) {
  if (!text || text.trim() === '') return text;
  if (/^\d+([.,]\d+)?$/.test(text.trim())) return text;

  // For very long texts, chunk them to avoid request size limits
  const MAX_CHUNK = 1000;
  if (text.length > MAX_CHUNK) {
    const chunks = [];
    for (let i = 0; i < text.length; i += MAX_CHUNK) {
      chunks.push(text.substring(i, i + MAX_CHUNK));
    }
    const results = await Promise.all(chunks.map(c => translatePlainText(c, langPair, retries)));
    if (results.some(r => r === null)) return null;
    return results.join('');
  }

  const [sl, tl] = langPair.split('|');

  for (let attempt = 0; attempt < retries; attempt++) {
    // Primary: Google Translate (fast, no key needed)
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
      const res = await fetch(url);

      if (res.status === 429) {
        const wait = Math.pow(2, attempt) * 1000;
        console.warn(`Google rate limited. Waiting ${wait}ms...`);
        await sleep(wait);
        continue;
      }

      const data = await res.json();
      if (data && data[0]) {
        const translated = data[0].map(seg => seg[0]).join('');
        if (translated) return translated;
      }
    } catch (err) {
      console.warn(`Google Translate attempt ${attempt + 1} failed:`, err);
      logError(`Google Translate (${sl}|${tl})`, err.message || 'Error de red');
    }

    // Fallback: MyMemory API
    try {
      const url2 = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${langPair}`;
      const res2 = await fetch(url2);
      const data2 = await res2.json();
      if (data2.responseStatus === 200 && data2.responseData?.translatedText) {
        return data2.responseData.translatedText;
      } else if (data2.responseStatus !== 200) {
        console.warn('MyMemory API error:', data2.responseDetails);
      }
    } catch (e) {
      console.warn('MyMemory fallback failed:', e);
    }

    if (attempt < retries - 1) await sleep(1000);
  }
  return null; // all retries exhausted, signal failure
}



function updateProgress(done, total, message, successCount, failedCount) {
  const pct = total === 0 ? 100 : Math.round((done / total) * 100);
  progressFill.style.width = pct + '%';
  progressPct.textContent = pct + '%';
  progressText.textContent = message;
  progressDetail.textContent = `${done} de ${total} celdas traducidas`;

  // Update verification panel
  const verifyPanel = $('verificationPanel');
  if (verifyPanel && successCount !== undefined) {
    $('verifySuccess').textContent = successCount;
    $('verifyFailed').textContent = failedCount || 0;
    // Color the failed count red if > 0
    const failedEl = $('verifyFailed');
    if (failedEl) failedEl.style.color = failedCount > 0 ? '#ff4d4d' : '#4ade80';
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Result ─────────────────────────────────────────────────
function showResult(totalCells, successCount, failedCount, skippedRows) {
  stepProgress.classList.add('hidden');
  stepResult.classList.remove('hidden');

  // Stats with verification info
  let statsHTML = `
    <div class="stat-chip">📊 <strong>${state.rows.length}</strong> filas totales</div>
    <div class="stat-chip">📋 <strong>${state.headers.length}</strong> columnas</div>
    <div class="stat-chip">✅ <strong>${successCount || totalCells}</strong> celdas traducidas</div>
    <div class="stat-chip">🌐 Idioma destino: <strong>Español</strong></div>
  `;

  if (failedCount > 0) {
    statsHTML += `<div class="stat-chip" style="background:rgba(255,77,77,0.15);border-color:#ff4d4d;">⚠️ <strong>${failedCount}</strong> celdas sin traducir</div>`;
  }

  if (skippedRows > 0) {
    statsHTML += `<div class="stat-chip" style="background:rgba(255,165,0,0.15);border-color:#ffa500;">⏭️ <strong>${skippedRows}</strong> productos pendientes (lote siguiente)</div>`;
  }

  resultStats.innerHTML = statsHTML;

  buildResultTable(resultTable, state.translatedRows, false);
  buildResultTable(comparisonTable, state.translatedRows, true);

  const sStep = $('shopifyStep');
  if (sStep) {
    console.log("Showing shopifyStep in showResult");
    sStep.classList.remove('hidden');
  }
}

function buildResultTable(tableEl, rows, comparison) {
  let html = '<thead><tr>';
  if (comparison) {
    state.headers.forEach((h, i) => {
      if (state.selectedCols.has(i)) {
        html += `<th>${escapeHtml(h)} (original)</th><th>${escapeHtml(h)} (español)</th>`;
      } else {
        html += `<th>${escapeHtml(h)}</th>`;
      }
    });
  } else {
    state.headers.forEach(h => { html += `<th>${escapeHtml(h)}</th>`; });
  }
  html += '</tr></thead><tbody>';

  const maxRows = 50;
  rows.slice(0, maxRows).forEach((row, rowIdx) => {
    html += '<tr>';
    if (comparison) {
      state.headers.forEach((_, i) => {
        if (state.selectedCols.has(i)) {
          html += `<td class="original" title="${escapeHtml(state.rows[rowIdx][i] || '')}">${escapeHtml(state.rows[rowIdx][i] || '')}</td>`;
          html += `<td class="translated" title="${escapeHtml(row[i] || '')}">${escapeHtml(row[i] || '')}</td>`;
        } else {
          html += `<td title="${escapeHtml(row[i] || '')}">${escapeHtml(row[i] || '')}</td>`;
        }
      });
    } else {
      state.headers.forEach((_, i) => {
        const cls = state.selectedCols.has(i) ? ' class="translated"' : '';
        html += `<td${cls} title="${escapeHtml(row[i] || '')}">${escapeHtml(row[i] || '')}</td>`;
      });
    }
    html += '</tr>';
  });

  if (rows.length > maxRows) {
    const cols = comparison
      ? state.headers.reduce((acc, _, i) => acc + (state.selectedCols.has(i) ? 2 : 1), 0)
      : state.headers.length;
    html += `<tr><td colspan="${cols}" style="text-align:center;color:var(--text-muted);font-style:italic">... y ${rows.length - maxRows} filas más (todas incluidas en la descarga)</td></tr>`;
  }
  html += '</tbody>';
  tableEl.innerHTML = html;
}

// ── Tabs ───────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).classList.remove('hidden');
  });
});

// ── Download ───────────────────────────────────────────────
// ── Smart Tag Generation ───────────────────────────────────
// Format: PRENDA GENERO (uppercase), e.g., POLO HOMBRE
const GARMENT_DETECT = [
  { keywords: ['polo'], label: 'POLO' },
  { keywords: ['camiseta', 'remera', 'playera', 't-shirt', 'tshirt'], label: 'CAMISETA' },
  { keywords: ['camisa', 'shirt', 'blusa'], label: 'CAMISA' },
  { keywords: ['sudadera', 'hoodie', 'suéter'], label: 'SUDADERA' },
  { keywords: ['chaqueta', 'jacket', 'cazadora', 'chamarra'], label: 'CHAQUETA' },
  { keywords: ['pantalón', 'pantalones', 'pants', 'jean', 'vaquero'], label: 'PANTALON' },
  { keywords: ['shorts', 'bermuda'], label: 'SHORTS' },
  { keywords: ['vestido', 'dress'], label: 'VESTIDO' },
  { keywords: ['falda', 'skirt'], label: 'FALDA' },
  { keywords: ['zapato', 'shoes', 'zapatilla', 'sneaker', 'tenis'], label: 'ZAPATOS' },
  { keywords: ['bolso', 'bag', 'mochila'], label: 'BOLSO' },
  { keywords: ['gorro', 'hat', 'sombrero', 'gorra'], label: 'GORRO' },
  { keywords: ['reloj', 'watch'], label: 'RELOJ' },
];

function generateTags(row, titleIdx, typeIdx, opt1NameIdx, opt2NameIdx) {
  const title = (titleIdx >= 0 ? row[titleIdx] || '' : '').toLowerCase();
  const type = (typeIdx >= 0 ? row[typeIdx] || '' : '').toLowerCase();
  const combined = title + ' ' + type;

  // Detect garment
  let garment = '';
  for (const g of GARMENT_DETECT) {
    if (g.keywords.some(k => combined.includes(k))) {
      garment = g.label;
      break;
    }
  }

  // Detect gender
  let gender = '';
  if (combined.includes('hombre') || combined.includes('caballero') || combined.includes('männer') || combined.includes('herren') || combined.includes('men')) {
    gender = 'HOMBRE';
  } else if (combined.includes('mujer') || combined.includes('dama') || combined.includes('frauen') || combined.includes('damen') || combined.includes('women')) {
    gender = 'MUJER';
  } else if (combined.includes('niño') || combined.includes('kinder') || combined.includes('kids')) {
    gender = 'NIÑO';
  } else if (combined.includes('unisex')) {
    gender = 'UNISEX';
  }

  // Combine: PRENDA GENERO
  if (garment && gender) return `${garment} ${gender}`;
  if (garment) return garment;
  if (gender) return gender;
  return '';
}


downloadBtn.addEventListener('click', downloadCSV);

function buildCSVContent() {
  // Force Vendor to "Rovelli Maison" and generate smart tags
  const vendorIdx = state.headers.indexOf('Vendor');
  const tagsIdx = state.headers.indexOf('Tags');
  const titleIdx = state.headers.indexOf('Title');
  const typeIdx = state.headers.indexOf('Type');
  const opt1NameIdx = state.headers.indexOf('Option1 Name') >= 0
    ? state.headers.indexOf('Option1 Name')
    : state.headers.indexOf('Option1 name');
  const opt2NameIdx = state.headers.indexOf('Option2 Name') >= 0
    ? state.headers.indexOf('Option2 Name')
    : state.headers.indexOf('Option2 name');

  // Shopify requires these exact values on variant rows only
  const invPolicyIdx = state.headers.indexOf('Variant Inventory Policy');
  const fulfillIdx = state.headers.indexOf('Variant Fulfillment Service');
  const priceIdx = state.headers.indexOf('Variant Price');

  const VALID_INV_POLICIES = new Set(['deny', 'continue']);

  const rows = state.translatedRows.map(row => {
    const r = [...row];

    // Image-only rows have no Variant Price — skip variant enforcement on them
    const isVariantRow = priceIdx < 0 || (r[priceIdx] || '').trim() !== '';

    if (vendorIdx >= 0 && isVariantRow) r[vendorIdx] = brandNameInput.value || 'Rovelli Maison';

    // Ensure Shopify-required fields always have valid values (variant rows only)
    if (isVariantRow) {
      if (invPolicyIdx >= 0 && !VALID_INV_POLICIES.has((r[invPolicyIdx] || '').trim().toLowerCase())) {
        r[invPolicyIdx] = 'deny';
      }
      if (fulfillIdx >= 0 && !(r[fulfillIdx] || '').trim()) {
        r[fulfillIdx] = 'manual';
      }
    }

    // Clear metadata columns if they are not selected
    state.headers.forEach((h, i) => {
      if (SHOPIFY_CLEARED_COLS.has(h) && !state.selectedCols.has(i)) {
        r[i] = '';
      }
    });

    // Generate relevant tags based on product data (only if Tags column is active)
    if (tagsIdx >= 0 && state.selectedCols.has(tagsIdx)) {
      const tags = generateTags(r, titleIdx, typeIdx, opt1NameIdx, opt2NameIdx);
      r[tagsIdx] = tags;
    }
    return r;
  });

  // Output CSV with EXACT same headers as input — no renaming
  const lines = [state.headers, ...rows].map(row =>
    row.map(cell => {
      const s = String(cell ?? '');
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    }).join(',')
  );
  return lines.join('\r\n');
}

function downloadCSV() {
  const csvContent = buildCSVContent();
  // Use ASCII-only suffix to avoid filename encoding issues on any OS/browser
  const baseName = state.fileName.replace(/\.csv$/i, '').replace(/[^a-zA-Z0-9_\-]/g, '_');
  const fileName = baseName + '_traducido.csv';
  const BOM = '\uFEFF'; // UTF-8 BOM so Excel opens accents correctly

  let downloaded = false;

  // Method 1: Blob + createObjectURL
  try {
    const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    downloaded = true;
  } catch (e) {
    console.warn('Blob download failed, trying data URI:', e);
  }

  // Method 2: data: URI fallback
  if (!downloaded) {
    try {
      const encoded = encodeURIComponent(BOM + csvContent);
      const a = document.createElement('a');
      a.href = 'data:text/csv;charset=utf-8,' + encoded;
      a.download = fileName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      downloaded = true;
    } catch (e) {
      console.warn('data URI download failed:', e);
    }
  }

  // Always show the copy modal so the user can get the data regardless
  showCopyModal(csvContent, fileName);
}

// ── Copy Modal ─────────────────────────────────────────────
function showCopyModal(csvContent, fileName) {
  const modal = $('copyModal');
  const textarea = $('csvTextarea');
  textarea.value = csvContent;
  modal.classList.remove('hidden');
}

$('closeCopyModal').addEventListener('click', () => $('copyModal').classList.add('hidden'));
$('copyModal').addEventListener('click', e => { if (e.target === $('copyModal')) $('copyModal').classList.add('hidden'); });

$('copyClipboardBtn').addEventListener('click', () => {
  const textarea = $('csvTextarea');
  textarea.select();
  try {
    navigator.clipboard.writeText(textarea.value).then(() => {
      $('copyClipboardBtn').textContent = '✅ ¡Copiado!';
      setTimeout(() => { $('copyClipboardBtn').textContent = '📋 Copiar al portapapeles'; }, 2000);
    });
  } catch (e) {
    document.execCommand('copy');
    $('copyClipboardBtn').textContent = '✅ ¡Copiado!';
    setTimeout(() => { $('copyClipboardBtn').textContent = '📋 Copiar al portapapeles'; }, 2000);
  }
});

// ── Start Over ─────────────────────────────────────────────
startOverBtn.addEventListener('click', () => {
  stepResult.classList.add('hidden');
  resetUpload();
});

// ── Helpers ────────────────────────────────────────────────
// ── Helpers ────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}


// ── Shopify import ──────────────────────────────────────────────────────────
(function () {
  const connStatus = $('shopifyConnStatus');
  const importBtn = $('shopifyDirectImport');
  const importLog = $('shopifyImportLog');

  if (!importBtn) return; // guard if elements not present

  function getCredentials() {
    const store = (localStorage.getItem('shp_store') || '').trim().replace(/https?:\/\//, '').replace(/\/$/, '');
    const token = (localStorage.getItem('shp_token') || '').trim();
    return { store, token };
  }

  function showConnStatus(msg, type) {
    if (!connStatus) return;
    connStatus.style.display = '';
    connStatus.textContent = msg;
    connStatus.style.color = type === 'ok' ? '#4ade80'
      : type === 'error' ? '#f87171'
        : type === 'warn' ? '#fbbf24'
          : 'rgba(255,255,255,0.6)';
  }

  importBtn.onclick = async () => {
    const { store, token } = getCredentials();
    importBtn.disabled = true;
    importLog.style.display = '';
    // Helper for case-insensitive header matching
    const hArr = state.headers.map(v => (v || '').trim().toLowerCase());
    const findCol = candidates => {
      for (const c of candidates) {
        const idx = hArr.indexOf(c.toLowerCase());
        if (idx >= 0) return idx;
      }
      return -1;
    };

    const handleIdx = findCol(['Handle', 'URL handle', 'handle', 'id']);
    const titleIdx = findCol(['Title', 'title', 'nombre', 'product title']);

    // Determine the grouping key for a row
    const getRowKey = row => {
      const h = handleIdx >= 0 ? (row[handleIdx] || '').toString().trim() : '';
      const t = titleIdx >= 0 ? (row[titleIdx] || '').toString().trim() : '';
      return (h || t || '').toLowerCase();
    };

    // Scraper flow: use selectedProducts. CSV flow: build product list from rows grouped by Handle.
    let products = state.selectedProducts;
    if (!products.length) {
      // Reconstruct product list from CSV (translated or raw)
      const rows = state.translatedRows.length > 0 ? state.translatedRows : state.rows;
      if (rows.length === 0) { showConnStatus('No hay productos para importar.', 'warn'); importBtn.disabled = false; return; }

      products = [];
      const seen = new Set();
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const originalRow = state.rows[rowIndex];
        if (!originalRow) continue;
        const key = getRowKey(originalRow);
        const title = (titleIdx >= 0 ? rows[rowIndex][titleIdx] : '') || key; // rows[rowIndex] contains translated title
        if (key && !seen.has(key)) {
          seen.add(key);
          // For manual CSV, we use the key as the identifier
          products.push({ handle: key, title, fromCSV: true });
        }
      }
    }
    if (!products.length) { importBtn.disabled = false; return; }
    let ok = 0, fail = 0;

    for (let i = 0; i < products.length; i++) {
      const orig = products[i];
      const payload = buildShopifyPayload(orig);
      const lang = sourceLang.value;
      const langPair = lang === 'auto' ? 'auto|es' : `${lang}|es`;

      // If these are scraped products (scrapedProducts.length > 0)
      // their titles MUST be translated here because they aren't in the CSV loop.
      if (state.scrapedProducts.length > 0) {
        try {
          if (payload.title) {
            const tTitle = await translateText(payload.title, langPair);
            if (tTitle) payload.title = tTitle;
          }
          if (payload.body_html) {
            const tBody = await translateText(payload.body_html, langPair);
            if (tBody) payload.body_html = tBody;
          }
          // Translate unique variant option values (colors, materials, etc.)
          const optValuesToTranslate = new Set();
          if (payload.variants) {
            for (const v of payload.variants) {
              if (v.option1 && v.option1 !== 'Default Title') optValuesToTranslate.add(v.option1);
              if (v.option2) optValuesToTranslate.add(v.option2);
              if (v.option3) optValuesToTranslate.add(v.option3);
            }
          }
          const optTranslations = {};
          for (const val of optValuesToTranslate) {
            const t = await translateText(val, langPair);
            if (t && t !== val) optTranslations[val] = t;
          }
          if (Object.keys(optTranslations).length > 0) {
            if (payload.variants) {
              for (const v of payload.variants) {
                if (optTranslations[v.option1]) v.option1 = optTranslations[v.option1];
                if (optTranslations[v.option2]) v.option2 = optTranslations[v.option2];
                if (optTranslations[v.option3]) v.option3 = optTranslations[v.option3];
              }
            }
            if (payload.options) {
              for (const opt of payload.options) {
                if (opt.values) opt.values = opt.values.map(v => optTranslations[v] || v);
              }
            }
          }
        } catch (e) {
          console.warn('Scraper translation failed:', e);
        }
      }

      // Generate AI tag + brand title via Gemini (best-effort, non-blocking)
      try {
        const tagRes = await fetch('/api/tag', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: payload.title, original_title: orig.title, body_html: payload.body_html, vendor: payload.vendor }),
        });
        if (tagRes.ok) {
          const { tag, title: aiTitle } = await tagRes.json();
          // Title enrichment is disabled per user request:
          // if (aiTitle) payload.title = aiTitle;

          // Tag = product name: take from AI, or extract from title before ' - '
          if (tag) {
            payload.tags = tag;
          } else if (aiTitle && aiTitle.includes(' - ')) {
            payload.tags = aiTitle.split(' - ')[0].trim();
          }
        }
      } catch (_) { /* ignore AI errors, continue with import */ }

      // Final fallback: if still no tag but title has ' - ', extract it
      if (!payload.tags && payload.title && payload.title.includes(' - ')) {
        payload.tags = payload.title.split(' - ')[0].trim();
      }

      const logItem = addLogItem(`⏳ (${i + 1}/${products.length}) ${orig.title}...`);

      try {
        const res = await fetch('/api/shopify/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ store, token, product: payload }),
        });
        const data = await res.json();
        if (data.success) {
          logItem.textContent = `✅ (${i + 1}/${products.length}) ${orig.title} — ${data.product.variants_count} variante(s)`;
          logItem.style.color = '#4ade80';
          ok++;
        } else {
          logItem.textContent = `❌ (${i + 1}/${products.length}) ${orig.title}: ${typeof data.error === 'object' ? JSON.stringify(data.error) : (data.error || 'Error desconocido')}`;
          logItem.style.color = '#f87171';
          fail++;
        }
      } catch (e) {
        logItem.textContent = `❌ (${i + 1}/${products.length}) ${orig.title}: ${e.message}`;
        logItem.style.color = '#f87171';
        fail++;
      }

      // Small delay to respect Shopify rate limits (2 req/s)
      await new Promise(r => setTimeout(r, 600));
    }

    const summary = document.createElement('p');
    summary.style.cssText = 'margin:12px 0 0;font-weight:600;';
    summary.textContent = `Listo: ${ok} importados, ${fail} errores.`;
    importLog.appendChild(summary);
    importBtn.disabled = false;
  };

  function buildShopifyPayload(orig) {
    const hArr = state.headers.map(v => (v || '').trim().toLowerCase());
    const findCol = candidates => {
      for (const c of candidates) {
        const idx = hArr.indexOf(c.toLowerCase());
        if (idx >= 0) return idx;
      }
      return -1;
    };

    const handleIdx = findCol(['Handle', 'URL handle', 'handle', 'id']);
    const titleIdx = findCol(['Title', 'title', 'nombre', 'product title']);
    const bodyIdx = findCol(['Body (HTML)', 'body', 'description', 'descripción', 'cuerpo']);
    const vendorIdx = findCol(['Vendor', 'vendedor', 'marca', 'brand']);
    const typeIdx = findCol(['Type', 'tipo', 'categoría', 'product type']);
    const tagsIdx = findCol(['Tags', 'etiquetas', 'tags']);

    const opt1NameIdx = findCol(['Option1 Name', 'option 1 name', 'opción 1 nombre']);
    const opt2NameIdx = findCol(['Option2 Name', 'option 2 name', 'opción 2 nombre']);
    const opt3NameIdx = findCol(['Option3 Name', 'option 3 name', 'opción 3 nombre']);
    const opt1ValIdx = findCol(['Option1 Value', 'option 1 value', 'opción 1 valor']);
    const opt2ValIdx = findCol(['Option2 Value', 'option 2 value', 'opción 2 valor']);
    const opt3ValIdx = findCol(['Option3 Value', 'option 3 value', 'opción 3 valor']);

    const priceIdx = findCol(['Variant Price', 'price', 'precio', 'variant_price', 'amount']);
    const skuIdx = findCol(['Variant SKU', 'sku', 'referencia', 'variant_sku', 'code']);
    const weightIdx = findCol(['Variant Grams', 'grams', 'peso', 'variant_grams', 'weight']);
    const imgIdx = findCol(['Image Src', 'image', 'imagen', 'img', 'image_url', 'img_url', 'image_src']);
    const variantImgIdx = findCol(['Variant Image', 'variant image', 'variant_image']);
    const imgAltIdx = findCol(['Image Alt Text', 'image_alt', 'texto_alt_imagen', 'alt_text']);

    // Use translated rows if available message content is translated, otherwise raw rows
    const sourceRows = state.translatedRows.length > 0 ? state.translatedRows : state.rows;

    // For stable grouping (translation might change Title, but Handle/Identity should remain)
    // we use the original row corresponding to this translated row's index if possible.
    const allProductRows = sourceRows.filter((r, idx) => {
      const originalRow = state.rows[idx];
      if (!originalRow) return false;
      const h = handleIdx >= 0 ? (originalRow[handleIdx] || '').toString().trim() : '';
      const t = titleIdx >= 0 ? (originalRow[titleIdx] || '').toString().trim() : '';
      const key = (h || t || '').toLowerCase();
      return key === (orig.handle || '').toLowerCase();
    });

    // If we're coming from a manual CSV, we need to reconstruct EVERYTHING from these rows
    if (orig.fromCSV) {
      const firstWithData = allProductRows.find(r => (r[titleIdx] || '').toString().trim()) || allProductRows[0];
      const title = (firstWithData[titleIdx] || orig.title || '').toString().trim();
      const body_html = (bodyIdx >= 0 ? firstWithData[bodyIdx] : '').toString().trim();
      const vendor = (vendorIdx >= 0 ? (firstWithData[vendorIdx] || brandNameInput.value) : brandNameInput.value).toString().trim();
      const product_type = (typeIdx >= 0 ? (firstWithData[typeIdx] || '') : '').toString().trim();
      const tags = (tagsIdx >= 0 ? (firstWithData[tagsIdx] || '') : '').toString().trim();

      // Variants
      const variants = allProductRows
        .filter(r => (r[priceIdx] || '').toString().trim() !== '' || (r[skuIdx] || '').toString().trim() !== '' || (r[opt1ValIdx] || '').toString().trim() !== '')
        .map(r => {
          const rawImg = (() => {
            const vi = variantImgIdx >= 0 ? (r[variantImgIdx] || '').toString().trim() : '';
            if (vi) return vi;
            return imgIdx >= 0 ? (r[imgIdx] || '').toString().trim() : '';
          })();
          const variantImg = rawImg.startsWith('//') ? 'https:' + rawImg : rawImg;

          return {
            option1: opt1ValIdx >= 0 ? (r[opt1ValIdx] || 'Default Title') : 'Default Title',
            option2: opt2ValIdx >= 0 ? (r[opt2ValIdx] || undefined) : undefined,
            option3: opt3ValIdx >= 0 ? (r[opt3ValIdx] || undefined) : undefined,
            price: (r[priceIdx] || '0').toString().replace(/[^0-9.]/g, ''),
            sku: skuIdx >= 0 ? (r[skuIdx] || '').toString().trim() : '',
            grams: weightIdx >= 0 ? parseInt(r[weightIdx]) || 0 : 0,
            _variant_image_src: variantImg,
            inventory_management: null,
            inventory_policy: 'continue',
            fulfillment_service: 'manual'
          };
        });

      // Options (default to 'Title' if name is missing but values exist)
      const options = [];
      if (allProductRows.some(r => r[opt1ValIdx])) {
        options.push({ name: (opt1NameIdx >= 0 && firstWithData[opt1NameIdx]) ? firstWithData[opt1NameIdx] : 'Title', values: [...new Set(allProductRows.map(r => r[opt1ValIdx]).filter(v => v))] });
      }
      if (allProductRows.some(r => r[opt2ValIdx])) {
        options.push({ name: (opt2NameIdx >= 0 && firstWithData[opt2NameIdx]) ? firstWithData[opt2NameIdx] : 'Option 2', values: [...new Set(allProductRows.map(r => r[opt2ValIdx]).filter(v => v))] });
      }
      if (allProductRows.some(r => r[opt3ValIdx])) {
        options.push({ name: (opt3NameIdx >= 0 && firstWithData[opt3NameIdx]) ? firstWithData[opt3NameIdx] : 'Option 3', values: [...new Set(allProductRows.map(r => r[opt3ValIdx]).filter(v => v))] });
      }

      // Images (Deduplicated) — collect from Image Src AND Variant Image columns
      const imageMap = new Map();
      allProductRows.forEach(r => {
        const src = (r[imgIdx] || '').toString().trim();
        if (src && (src.startsWith('http') || src.startsWith('//'))) {
          const fullSrc = src.startsWith('//') ? 'https:' + src : src;
          if (!imageMap.has(fullSrc)) {
            imageMap.set(fullSrc, { src: fullSrc, alt: (imgAltIdx >= 0 ? r[imgAltIdx] : '') || '' });
          }
        }
        if (variantImgIdx >= 0) {
          const vsrc = (r[variantImgIdx] || '').toString().trim();
          if (vsrc && (vsrc.startsWith('http') || vsrc.startsWith('//'))) {
            const fullVsrc = vsrc.startsWith('//') ? 'https:' + vsrc : vsrc;
            if (!imageMap.has(fullVsrc)) {
              imageMap.set(fullVsrc, { src: fullVsrc, alt: '' });
            }
          }
        }
      });
      const images = Array.from(imageMap.values());

      return {
        title, body_html, vendor, product_type, tags,
        status: 'active',
        options: options.length ? options : undefined,
        variants: variants.length ? variants : [{ price: '0', option1: 'Default Title' }],
        images: images.length ? images : undefined
      };
    }

    // Scraper logic (original)
    const variantRows = allProductRows.filter(r => priceIdx < 0 || (r[priceIdx] || '').trim() !== '');
    const firstRow = variantRows.find(r => (r[titleIdx] || '').trim()) || variantRows[0] || [];

    const title = (firstRow[titleIdx] || orig.title || '').trim();
    const body_html = (firstRow[bodyIdx] || orig.body_html || '').trim();
    const opt1Name = (opt1NameIdx >= 0 ? firstRow[opt1NameIdx] : '') || (orig.options?.[0]?.name || '');
    const opt2Name = (opt2NameIdx >= 0 ? firstRow[opt2NameIdx] : '') || (orig.options?.[1]?.name || '');
    const opt3Name = (opt3NameIdx >= 0 ? firstRow[opt3NameIdx] : '') || (orig.options?.[2]?.name || '');

    const seen1 = new Set(), seen2 = new Set(), seen3 = new Set();
    const vals1 = [], vals2 = [], vals3 = [];
    variantRows.forEach(r => {
      const v1 = opt1ValIdx >= 0 ? (r[opt1ValIdx] || '').trim() : '';
      const v2 = opt2ValIdx >= 0 ? (r[opt2ValIdx] || '').trim() : '';
      const v3 = opt3ValIdx >= 0 ? (r[opt3ValIdx] || '').trim() : '';
      if (v1 && !seen1.has(v1)) { seen1.add(v1); vals1.push(v1); }
      if (v2 && !seen2.has(v2)) { seen2.add(v2); vals2.push(v2); }
      if (v3 && !seen3.has(v3)) { seen3.add(v3); vals3.push(v3); }
    });

    const options = (orig.options || []).map((opt, idx) => {
      const name = [opt1Name, opt2Name, opt3Name][idx] || opt.name;
      const values = [vals1, vals2, vals3][idx];
      return { name, values: values && values.length ? values : opt.values };
    });

    const variants = (orig.variants || []).map((v, i) => {
      const row = variantRows[i] || [];
      const translOpt1 = opt1ValIdx >= 0 ? (row[opt1ValIdx] || '').trim() : '';
      const translOpt2 = opt2ValIdx >= 0 ? (row[opt2ValIdx] || '').trim() : '';
      const translOpt3 = opt3ValIdx >= 0 ? (row[opt3ValIdx] || '').trim() : '';

      const rawImg = (() => {
        const vi = variantImgIdx >= 0 ? (row[variantImgIdx] || '').toString().trim() : '';
        if (vi && (vi.startsWith('http') || vi.startsWith('//'))) return vi;
        const pi = imgIdx >= 0 ? (row[imgIdx] || '').toString().trim() : '';
        if (pi && (pi.startsWith('http') || pi.startsWith('//'))) return pi;
        if (v.featured_image) return v.featured_image.src;
        // Fallback: search orig.images for an image linked to this variant via variant_ids
        const fromList = (orig.images || []).find(img =>
          Array.isArray(img.variant_ids) && img.variant_ids.includes(v.id)
        );
        return fromList ? fromList.src : '';
      })();
      const variantImg = rawImg.startsWith('//') ? 'https:' + rawImg : rawImg;

      const vObj = {
        option1: translOpt1 || v.option1 || '',
        price: v.price || '0',
        sku: v.sku || '',
        grams: v.grams || 0,
        inventory_management: null,
        inventory_policy: 'continue',
        fulfillment_service: v.fulfillment_service || 'manual',
        taxable: v.taxable !== false,
        requires_shipping: v.requires_shipping !== false,
        barcode: v.barcode || '',
        _variant_image_src: variantImg,
      };
      if (v.compare_at_price) vObj.compare_at_price = v.compare_at_price;
      if (translOpt2 || v.option2) vObj.option2 = translOpt2 || v.option2;
      if (translOpt3 || v.option3) vObj.option3 = translOpt3 || v.option3;
      if (v.weight_unit) vObj.weight_unit = v.weight_unit;
      return vObj;
    });

    const images = (orig.images || []).map(img => ({ src: img.src, alt: img.alt || '' }));

    return {
      title, body_html, vendor: brandNameInput.value.trim() || orig.vendor || '',
      product_type: '', tags: '', status: 'active',
      options: options.length ? options : undefined,
      variants, images,
    };
  }

  function showConnStatus(msg, type) {
    connStatus.textContent = msg;
    connStatus.style.display = '';
    connStatus.style.color = type === 'ok' ? '#4ade80' : type === 'error' ? '#f87171' : type === 'warn' ? '#fbbf24' : 'rgba(255,255,255,0.6)';
  }

  function addLogItem(text) {
    const p = document.createElement('p');
    p.style.cssText = 'margin:4px 0;';
    p.textContent = text;
    importLog.appendChild(p);
    importLog.scrollTop = importLog.scrollHeight;
    return p;
  }
})();

// ── Shopify OAuth (redirect flow — no popup) ────────────────────────────────
(function () {
  const connectBtn    = $('shopifyOAuthBtn');
  const storeInput    = $('shopifyOAuthStore');
  const oauthStatus   = $('shopifyOAuthStatus');
  const clientIdInput = $('oauthClientId');
  const clientSecInput= $('oauthClientSecret');
  const secretToggle  = $('oauthSecretToggle');
  const saveBtn       = $('oauthSaveBtn');
  const importBtn     = $('shopifyDirectImport');

  if (!connectBtn) return;

  // ── Load saved values ──
  if (clientIdInput)  clientIdInput.value  = localStorage.getItem('oauth_client_id')     || '';
  if (clientSecInput) clientSecInput.value = localStorage.getItem('oauth_client_secret') || '';
  if (storeInput)     storeInput.value     = localStorage.getItem('oauth_shop')           || '';

  // ── Toggle Client Secret visibility ──
  if (secretToggle && clientSecInput) {
    secretToggle.addEventListener('click', () => {
      clientSecInput.type = clientSecInput.type === 'password' ? 'text' : 'password';
    });
  }

  function setStatus(msg, color) {
    if (!oauthStatus) return;
    oauthStatus.textContent = msg;
    oauthStatus.style.color = color;
    oauthStatus.style.display = msg ? '' : 'none';
  }

  // ── Show connected state from previous session ──
  const savedStore = localStorage.getItem('shp_store') || '';
  const savedToken = localStorage.getItem('shp_token') || '';
  if (savedStore && savedToken) {
    setStatus(`✅ Conectado a "${savedStore}"`, '#4ade80');
    if (importBtn) importBtn.disabled = false;
  }

  // ── Process OAuth result written by oauth_callback.html on redirect back ──
  const pendingResult = localStorage.getItem('shopify_oauth_result');
  if (pendingResult) {
    localStorage.removeItem('shopify_oauth_result');
    try {
      const d = JSON.parse(pendingResult);
      if (d.type === 'shopify_oauth_success') {
        localStorage.setItem('shp_store',  d.store);
        localStorage.setItem('shp_token',  d.token);
        localStorage.setItem('oauth_shop', d.store);
        // Also populate manual token inputs so existing import flow works
        const destStore = $('shopifyDestStore');
        const destToken = $('shopifyDestToken');
        if (destStore) destStore.value = d.store;
        if (destToken) destToken.value = d.token;
        setStatus(`✅ ¡Conectado a "${d.shop_name}"!`, '#4ade80');
        if (importBtn) importBtn.disabled = false;
        setTimeout(() => oauthStatus && oauthStatus.scrollIntoView({ behavior: 'smooth', block: 'center' }), 200);
      } else {
        setStatus(`❌ ${typeof d.error === 'object' ? JSON.stringify(d.error) : (d.error || 'Error de autorización')}`, '#f87171');
      }
    } catch (_) {}
  }

  // ── Save credentials ──
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const id  = (clientIdInput  ? clientIdInput.value  : '').trim();
      const sec = (clientSecInput ? clientSecInput.value : '').trim();
      const shop= (storeInput     ? storeInput.value     : '').trim();
      if (id)   localStorage.setItem('oauth_client_id',     id);
      if (sec)  localStorage.setItem('oauth_client_secret', sec);
      if (shop) localStorage.setItem('oauth_shop',          shop);
      const badge = $('oauthConfigSaved');
      if (badge) { badge.style.display = ''; setTimeout(() => { badge.style.display = 'none'; }, 2000); }
    });
  }

  // ── "Conectar con Shopify" — full-page redirect, no popup ──
  connectBtn.addEventListener('click', async () => {
    const shop     = ((storeInput ? storeInput.value : '') || localStorage.getItem('oauth_shop') || '').trim()
                       .replace(/https?:\/\//, '').replace(/\/$/, '');
    const clientId = localStorage.getItem('oauth_client_id')     || '';
    const clientSec= localStorage.getItem('oauth_client_secret') || '';

    if (!shop) {
      setStatus('⚠️ Escribe el dominio de tu tienda en el campo de arriba', '#fbbf24');
      return;
    }
    if (!clientId || !clientSec) {
      setStatus('⚠️ Guarda primero tu Client ID y Client Secret', '#fbbf24');
      return;
    }

    connectBtn.disabled = true;
    setStatus('⏳ Conectando con Shopify...', 'rgba(255,255,255,0.55)');

    try {
      const appUrl = window.location.origin;
      const params = new URLSearchParams({ shop, client_id: clientId, app_url: appUrl });
      const res    = await fetch(`/api/shopify/oauth_start?${params}`);
      const data   = await res.json();

      if (!data.auth_url) {
        setStatus(`❌ ${typeof data.error === 'object' ? JSON.stringify(data.error) : (data.error || 'Error al generar URL')}`, '#f87171');
        connectBtn.disabled = false;
        return;
      }

      // Redirect this page to Shopify — callback will redirect back here
      window.location.href = data.auth_url;

    } catch (e) {
      setStatus(`❌ ${e.message}`, '#f87171');
      connectBtn.disabled = false;
    }
  });
})();

// ── Panel de gestión de productos ───────────────────────────────────────────
(function () {
  const toggleBtn         = $('mgmtToggleBtn');
  const toggleArrow       = $('mgmtToggleArrow');
  const panel             = $('mgmtPanel');
  const loadBtn           = $('mgmtLoadBtn');
  const searchInput       = $('mgmtSearch');
  const listEl            = $('mgmtList');
  const statusEl          = $('mgmtStatus');
  const prevBtn           = $('mgmtPrevBtn');
  const nextBtn           = $('mgmtNextBtn');
  const deleteSelectedBtn = $('mgmtDeleteSelectedBtn');

  if (!toggleBtn) return;

  let nextCursor    = null;
  let prevCursor    = null;
  let allProducts   = [];   // current page products
  let selectedIds   = new Set();
  const PAGE_LIMIT  = 20;

  function getCredentials() {
    const store = (localStorage.getItem('shp_store') || '').trim();
    const token = (localStorage.getItem('shp_token') || '').trim();
    return { store, token };
  }

  const connHint = $('mgmtConnHint');

  // Enable toggle when store is connected; update hint text
  function checkConnected() {
    const { store, token } = getCredentials();
    if (store && token) {
      toggleBtn.disabled = false;
      if (connHint) connHint.textContent = `Tienda conectada: ${store}`;
    }
  }
  checkConnected();
  window.addEventListener('load', checkConnected);

  // ── Toggle panel open/close ──
  toggleBtn.addEventListener('click', () => {
    const open = panel.style.display === 'none';
    panel.style.display = open ? '' : 'none';
    toggleArrow.textContent = open ? '▲' : '▼';
    toggleBtn.querySelector('span:last-child') && (toggleBtn.querySelector('span:last-child').textContent = open ? 'Ocultar' : 'Ver productos');
    if (open && listEl.children.length === 0) loadProducts(null);
  });

  // ── Load products ──
  loadBtn.addEventListener('click', () => { nextCursor = null; prevCursor = null; loadProducts(null); });

  prevBtn.addEventListener('click', () => { if (prevCursor) loadProducts(prevCursor, true); });
  nextBtn.addEventListener('click', () => { if (nextCursor) loadProducts(nextCursor, false); });

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    listEl.querySelectorAll('.mgmt-row').forEach(row => {
      row.style.display = (!q || row.dataset.title.includes(q)) ? '' : 'none';
    });
  });

  deleteSelectedBtn.addEventListener('click', async () => {
    if (!selectedIds.size) return;
    if (!confirm(`¿Eliminar ${selectedIds.size} producto(s) de Shopify?`)) return;
    setStatus('⏳ Eliminando...', false);
    deleteSelectedBtn.disabled = true;
    const { store, token } = getCredentials();
    const res = await fetch('/api/shopify/manage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store, token, action: 'delete_bulk', product_ids: [...selectedIds] }),
    });
    const data = await res.json();
    setStatus(`✅ Eliminados: ${data.deleted} · Errores: ${data.errors}`, false);
    selectedIds.clear();
    updateDeleteBtn();
    nextCursor = null; prevCursor = null;
    loadProducts(null);
  });

  async function loadProducts(cursor) {
    const { store, token } = getCredentials();
    if (!store || !token) { setStatus('Conecta tu tienda primero.', true); return; }
    setStatus('⏳ Cargando productos...', false);
    loadBtn.disabled = true;
    try {
      let url = `/api/shopify/manage?store=${encodeURIComponent(store)}&token=${encodeURIComponent(token)}&limit=${PAGE_LIMIT}`;
      if (cursor) url += `&page_info=${encodeURIComponent(cursor)}`;
      const res  = await fetch(url);
      const data = await res.json();
      if (!res.ok) { setStatus(`❌ ${typeof data.error === 'object' ? JSON.stringify(data.error) : (data.error || 'Error desconocido')}`, true); return; }
      allProducts  = data.products || [];
      nextCursor   = data.next_cursor || null;
      prevCursor   = data.prev_cursor || null;
      renderProducts(allProducts);
      setStatus(`${allProducts.length} producto(s) cargados`, false);
      prevBtn.style.display = prevCursor ? '' : 'none';
      nextBtn.style.display = nextCursor ? '' : 'none';
    } catch (e) {
      setStatus(`❌ ${e.message}`, true);
    } finally {
      loadBtn.disabled = false;
    }
  }

  function renderProducts(products) {
    listEl.innerHTML = '';
    selectedIds.clear();
    updateDeleteBtn();
    if (!products.length) { listEl.innerHTML = '<p style="color:rgba(255,255,255,0.35);font-size:0.85rem;">No hay productos.</p>'; return; }

    products.forEach(p => {
      const row = document.createElement('div');
      row.className = 'mgmt-row';
      row.dataset.title = (p.title || '').toLowerCase();
      row.style.cssText = 'display:flex;align-items:center;gap:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:10px 12px;';

      // Checkbox
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.style.cssText = 'width:16px;height:16px;flex-shrink:0;cursor:pointer;accent-color:#96bf48;';
      cb.addEventListener('change', () => {
        if (cb.checked) selectedIds.add(p.id); else selectedIds.delete(p.id);
        updateDeleteBtn();
      });

      // Thumb
      const thumb = document.createElement('img');
      thumb.src   = p.thumb || '';
      thumb.alt   = '';
      thumb.style.cssText = 'width:44px;height:44px;object-fit:cover;border-radius:6px;flex-shrink:0;background:rgba(255,255,255,0.06);';
      if (!p.thumb) thumb.style.display = 'none';

      // Info
      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0;';
      info.innerHTML = `<p style="margin:0;font-size:0.88rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(p.title)}</p>
        <p style="margin:2px 0 0;font-size:0.75rem;color:rgba(255,255,255,0.35);">${p.variants.length} variante(s) · ${p.status}</p>`;

      // Actions
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;';

      const btnFix    = mkBtn('🔗 Imágenes',  '#96bf48', '0.2');
      const btnTrans  = mkBtn('🌐 Variantes', '#06b6d4', '0.2');
      const btnTitle  = mkBtn('📝 Título/Desc', '#a78bfa', '0.2');
      const btnDel    = mkBtn('🗑️', '#ef4444', '0.15');

      btnFix.title   = 'Relinkear imágenes de variantes por nombre de color';
      btnTrans.title = 'Traducir nombres de variantes al español';
      btnTitle.title = 'Traducir título y descripción al español';
      btnDel.title   = 'Eliminar producto de Shopify';

      btnFix.addEventListener('click',   () => fixImages(p, btnFix));
      btnTrans.addEventListener('click', () => translateVariants(p, btnTrans));
      btnTitle.addEventListener('click', () => translateTitleDesc(p, row, btnTitle));
      btnDel.addEventListener('click',   () => deleteProduct(p, row, btnDel));

      actions.append(btnFix, btnTrans, btnTitle, btnDel);
      row.append(cb, thumb, info, actions);
      listEl.appendChild(row);
    });
  }

  function mkBtn(label, color, alpha) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `padding:5px 10px;border-radius:7px;border:1px solid ${color}66;background:${color}${Math.round(parseFloat(alpha)*255).toString(16).padStart(2,'0')};color:${color};font-size:0.78rem;cursor:pointer;white-space:nowrap;`;
    return b;
  }

  // ── Fix images for a product ──
  async function fixImages(p, btn) {
    const { store, token } = getCredentials();
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = '⏳';
    try {
      const res = await fetch('/api/shopify/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store, token, action: 'fix_images', product_id: p.id }),
      });
      const data = await res.json();
      btn.textContent = data.linked > 0 ? `✅ ${data.linked} imág.` : '⚠️ 0';
    } catch (e) {
      btn.textContent = '❌';
    } finally {
      btn.disabled = false;
      setTimeout(() => { btn.textContent = orig; }, 3000);
    }
  }

  // ── Translate variant option values ──
  async function translateVariants(p, btn) {
    const { store, token } = getCredentials();
    const lang = (sourceLang && sourceLang.value !== 'auto') ? sourceLang.value : 'en';
    const langPair = `${lang}|es`;
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = '⏳';

    try {
      // Collect unique option values
      const unique = new Set();
      p.variants.forEach(v => {
        if (v.option1) unique.add(v.option1);
        if (v.option2) unique.add(v.option2);
        if (v.option3) unique.add(v.option3);
      });

      const translations = {};
      for (const val of unique) {
        const t = await translateText(val, langPair);
        if (t && t !== val) translations[val] = t;
      }

      if (!Object.keys(translations).length) {
        btn.textContent = '✓ Ya traducido';
        setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
        return;
      }

      // Apply translations to variant objects
      const updatedVariants = p.variants.map(v => ({
        id:      v.id,
        option1: translations[v.option1] || v.option1 || undefined,
        option2: translations[v.option2] || v.option2 || undefined,
        option3: translations[v.option3] || v.option3 || undefined,
      }));

      const res = await fetch('/api/shopify/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store, token, action: 'update_variants', product_id: p.id, variants: updatedVariants }),
      });
      const data = await res.json();
      btn.textContent = `✅ ${data.updated} var.`;
    } catch (e) {
      btn.textContent = '❌';
    } finally {
      btn.disabled = false;
      setTimeout(() => { btn.textContent = orig; }, 3500);
    }
  }

  // ── Translate product title and description ──
  async function translateTitleDesc(p, row, btn) {
    const { store, token } = getCredentials();
    const lang = (sourceLang && sourceLang.value !== 'auto') ? sourceLang.value : 'en';
    const langPair = `${lang}|es`;
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = '⏳';

    try {
      // Fetch full product to get body_html
      const fetchRes = await fetch(`/api/shopify/manage?store=${encodeURIComponent(store)}&token=${encodeURIComponent(token)}&product_id=${p.id}`);
      const fetchData = await fetchRes.json();
      if (!fetchRes.ok) { btn.textContent = '❌'; return; }

      const { title: currentTitle, body_html: currentBody } = fetchData.product;

      const [tTitle, tBody] = await Promise.all([
        currentTitle ? translateText(currentTitle, langPair) : Promise.resolve(currentTitle),
        currentBody  ? translateText(currentBody,  langPair) : Promise.resolve(currentBody),
      ]);

      await fetch('/api/shopify/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store, token, action: 'update_title_body', product_id: p.id, title: tTitle || currentTitle, body_html: tBody || currentBody }),
      });

      // Update the displayed title in the row
      if (tTitle) {
        p.title = tTitle;
        row.dataset.title = tTitle.toLowerCase();
        const titleEl = row.querySelector('p');
        if (titleEl) titleEl.textContent = tTitle;
      }

      btn.textContent = '✅ Traducido';
    } catch (e) {
      btn.textContent = '❌';
    } finally {
      btn.disabled = false;
      setTimeout(() => { btn.textContent = orig; }, 3000);
    }
  }

  // ── Delete a single product ──
  async function deleteProduct(p, row, btn) {
    if (!confirm(`¿Eliminar "${p.title}" de Shopify?`)) return;
    const { store, token } = getCredentials();
    btn.disabled = true; btn.textContent = '⏳';
    try {
      const res = await fetch('/api/shopify/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store, token, action: 'delete', product_id: p.id }),
      });
      const data = await res.json();
      if (data.success) {
        row.style.opacity = '0.3';
        row.style.pointerEvents = 'none';
        setTimeout(() => row.remove(), 800);
      } else {
        btn.textContent = '❌'; btn.disabled = false;
      }
    } catch (e) {
      btn.textContent = '❌'; btn.disabled = false;
    }
  }

  function updateDeleteBtn() {
    deleteSelectedBtn.style.display = selectedIds.size > 0 ? '' : 'none';
    deleteSelectedBtn.textContent = `🗑️ Eliminar seleccionados (${selectedIds.size})`;
  }

  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.color = isError ? '#f87171' : 'rgba(255,255,255,0.45)';
    statusEl.style.display = msg ? '' : 'none';
  }

  // Enable the toggle button as soon as the store is connected (OAuth redirect)
  const observer = new MutationObserver(() => checkConnected());
  const oauthStatus = $('shopifyOAuthStatus');
  if (oauthStatus) observer.observe(oauthStatus, { childList: true, subtree: true, characterData: true });
})();
