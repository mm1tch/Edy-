// content_script.js — Edy: widget controller + recorder + semantic field finder
//
// Responsibilities:
//  1. Connect the floating widget with the background (service worker).
//  2. Own the recording logic — more reliable than injecting via executeScript.
//  3. Expose window.edyEncontrarElemento for semantic fallback during execution.

(function () {
  if (window.__edyAgenteInyectado) return;
  window.__edyAgenteInyectado = true;

  const widget = window.EdyWidget;
  if (!widget) {
    console.error('[Edy] widget_ui.js must load before content_script.js');
    return;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Safe wrappers — "Extension context invalidated" is thrown when the extension
  // is reloaded while the page is still open. We catch it and bail gracefully.
  function isContextValid() {
    try { return Boolean(chrome.runtime?.id); } catch { return false; }
  }

  function sendMsg(msg) {
    if (!isContextValid()) return Promise.resolve(null);
    return chrome.runtime.sendMessage(msg).catch((err) => {
      if (!String(err).includes('context invalidated') && !String(err).includes('receiving end')) {
        console.warn('[Edy]', err);
      }
      return null;
    });
  }

  const getLocal = (keys) => new Promise((res) => {
    if (!isContextValid()) return res({});
    chrome.storage.local.get(keys, res);
  });

  // Re-renders the step checklist from the learned mapeo. Needed every time the
  // widget appears mid-execution on a freshly-loaded page — content_script.js
  // (and its DOM) is re-injected on every navigation, so the list rendered by
  // onEjecutar/onReejecutar is gone and "paso_actual"/"paso_completado" would
  // otherwise have no matching element to mark with a check.
  async function renderPasosEnEjecucion(mensajeVacio) {
    const storage = await getLocal(['mapeo_aprendido']);
    const mapeo   = storage['mapeo_aprendido'];
    const pasos   = (mapeo?.pasos || []).map(p => p.nombre).filter(Boolean);
    widget.renderPasos(pasos.length ? pasos : [mensajeVacio]);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RECORDING — all event capture lives here, not in an injected script
  // ─────────────────────────────────────────────────────────────────────────────

  let isRecording    = false;
  let recordedActions = [];
  let recorderHandlers = null;
  let lastClickRecordedAt = 0;

  const INTERACTIVE =
    'button, a, [role="button"], [role="link"], [role="menuitem"], ' +
    '[role="option"], [role="tab"], input[type="submit"], input[type="button"], ' +
    'input[type="checkbox"], input[type="radio"], select, [data-test], [data-testid]';

  const TEXT_INPUTS = new Set(['text','password','email','number','search','tel','url','date','time','']);

  function selectorPara(el) {
    if (!el || el === document) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const name = el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
    const aria = el.getAttribute('aria-label');
    if (aria) return el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(aria) + '"]';
    const test = el.getAttribute('data-test') || el.getAttribute('data-testid');
    if (test) return '[data-test="' + CSS.escape(test) + '"]';
    // Stable path from nearest unique ancestor
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter(h => h.tagName === cur.tagName);
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }

  function etiquetaPara(el) {
    const id = el.id;
    const v =
      (id && document.querySelector('label[for="' + CSS.escape(id) + '"]')?.innerText) ||
      el.closest('label')?.innerText ||
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('data-test') ||
      el.getAttribute('name') ||
      el.id ||
      (el.innerText || el.textContent || '');
    return String(v).trim().replace(/\s+/g, ' ').slice(0, 80);
  }

  // Capture the product/item name near a button for context during replay
  function contextoPara(el) {
    return detalleProductoPara(el).nombre || '';
  }

  function detalleProductoPara(el) {
    const card = el.closest(
      '[class*="item"], [class*="product"], [class*="card"], [class*="inventory"], ' +
      'li, article, tr, [class*="row"]'
    );
    if (!card) return {};

    const nameEl = encontrarNombreProducto(card, el);
    const priceEl = card.querySelector(
      '.inventory_item_price, [data-test="inventory-item-price"], [data-testid="inventory-item-price"], ' +
      '[class*="price"], [class*="cost"], [class*="amount"], [data-test*="price"], [data-testid*="price"]'
    );
    const id =
      card.getAttribute('data-id') ||
      card.getAttribute('data-sku') ||
      card.getAttribute('data-item-id') ||
      card.getAttribute('data-product-id') ||
      el.getAttribute('data-test') ||
      el.getAttribute('data-testid') ||
      card.querySelector('[data-id], [data-sku], [data-item-id], [data-product-id]')?.getAttribute('data-id') ||
      card.querySelector('[data-id], [data-sku], [data-item-id], [data-product-id]')?.getAttribute('data-sku') ||
      extraerIdProducto(card.innerText || card.textContent || '');

    return {
      id: String(id || '').trim().slice(0, 80),
      nombre: nameEl ? (nameEl.innerText || nameEl.textContent || '').trim().slice(0, 100) : '',
      precio: priceEl ? (priceEl.innerText || priceEl.textContent || '').trim().slice(0, 80) : extraerPrecio(card.innerText || card.textContent || ''),
    };
  }

  function encontrarNombreProducto(card, clickedEl) {
    const selectores = [
      '.inventory_item_name',
      '[data-test="inventory-item-name"]',
      '[data-testid="inventory-item-name"]',
      '[class*="product-name"]',
      '[class*="product_name"]',
      '[class*="item-name"]',
      '[class*="item_name"]',
      '[class*="title"]',
      'h1', 'h2', 'h3', 'h4', 'strong', 'b',
    ];

    for (const selector of selectores) {
      const el = card.querySelector(selector);
      if (esNombreProductoValido(el, clickedEl)) return el;
    }

    return Array.from(card.querySelectorAll('div, span, p'))
      .find(el => esNombreProductoValido(el, clickedEl));
  }

  function esNombreProductoValido(el, clickedEl) {
    if (!el || el === clickedEl) return false;
    if (el.closest('button, a, [role="button"], input')) return false;
    const texto = (el.innerText || el.textContent || '').trim();
    if (!texto || texto.length > 120) return false;
    const normalizado = texto.toLowerCase();
    if (normalizado.includes('add to cart') || normalizado.includes('remove') || normalizado.includes('view product')) return false;
    if (extraerPrecio(texto)) return false;
    return true;
  }

  function extraerPrecio(texto) {
    const match = String(texto || '').match(/(?:\$|USD|MXN|Rs\.?)\s*\d+(?:[.,]\d{1,2})?/i);
    return match ? match[0].trim() : '';
  }

  function extraerIdProducto(texto) {
    const match = String(texto || '').match(/\b(?:SKU|ID|Item|Producto|Product)[\s:#-]*([A-Z0-9_-]{2,})\b/i);
    return match ? match[1].trim() : '';
  }

  function registrarAccion(tipo, el) {
    if (!el) { console.log('[Edy] registrarAccion: dropped — el is null'); return; }
    if (el.closest?.('#edy-agent-host')) { console.log('[Edy] registrarAccion: dropped — widget host'); return; }
    const sel = selectorPara(el);
    if (!sel) {
      console.log('[Edy] registrarAccion: dropped — no selector for', el.tagName, el.id || el.className || '(no id/class)');
      return;
    }

    const accion = {
      id:          Date.now() + '-' + Math.random().toString(36).slice(2),
      tipo,
      selector:    sel,
      valor:       'value' in el ? el.value : '',
      texto:       (el.innerText || el.textContent || '').trim().slice(0, 100),
      tag:         el.tagName?.toLowerCase() || '',
      nombreCampo: etiquetaPara(el),
      contexto:    (tipo === 'click' || tipo === 'change') ? contextoPara(el) : '',
      detalle:      tipo === 'click' ? detalleProductoPara(el) : {},
      timestamp:   Date.now(),
      url:         location.href,
    };

    recordedActions.push(accion);
    console.log('[Edy] accion registrada ✓', tipo, sel, accion.texto.slice(0, 30) || '', '| contexto:', accion.contexto.slice(0, 30) || '(none)');
    sendMsg({ tipo: 'accion_grabada', accion });
  }

  function iniciarRecording() {
    if (recorderHandlers) {
      console.log('[Edy] iniciarRecording: already active, skipping');
      return;
    }
    isRecording = true;
    recordedActions = [];
    console.log('[Edy] iniciarRecording: listeners attached — grabando en', location.href);

    const onClick = (e) => {
      console.log('[Edy] onClick RAW:', e.target.tagName, '| isRecording:', isRecording, '| id:', e.target.id || '(none)');
      if (!isRecording) { console.log('[Edy] onClick: skipped — not recording'); return; }
      const tag  = (e.target.tagName || '').toLowerCase();
      const type = (e.target.type   || '').toLowerCase();
      if ((tag === 'input' && TEXT_INPUTS.has(type)) || tag === 'textarea') {
        console.log('[Edy] onClick: skipped — text input (captured by onInput instead)');
        return;
      }
      let el;
      try { el = e.target.closest(INTERACTIVE); }
      catch (err) { el = e.target; console.warn('[Edy] closest() failed:', err); }
      if (!el) {
        console.log('[Edy] onClick: skipped — no interactive element');
        return;
      }
      lastClickRecordedAt = Date.now();
      console.log('[Edy] click capturado →', el.tagName, '#' + (el.id || '?'), el.getAttribute('data-test') || el.textContent?.trim().slice(0, 30) || '');
      registrarAccion('click', el);
    };

    const onInput = (e) => {
      if (!isRecording) return;
      console.log('[Edy] onInput:', e.target.tagName, e.target.name || e.target.id || e.target.placeholder || '');
      registrarAccion('input', e.target);
    };

    const onChange = (e) => {
      if (!isRecording) return;
      const tag  = e.target.tagName?.toLowerCase();
      const type = (e.target.type || '').toLowerCase();
      if (tag === 'select' || type === 'checkbox' || type === 'radio') {
        console.log('[Edy] onChange:', tag, e.target.name || e.target.id || '');
        registrarAccion('change', e.target);
      }
    };

    const onSubmit = (e) => {
      if (!isRecording) return;
      if (Date.now() - lastClickRecordedAt < 800) {
        console.log('[Edy] onSubmit: skipped — click already captured');
        return;
      }
      console.log('[Edy] onSubmit:', e.target.id || e.target.action || '');
      registrarAccion('submit', e.target);
    };

    recorderHandlers = { onClick, onInput, onChange, onSubmit };
    document.addEventListener('click',  onClick,  true);
    document.addEventListener('input',  onInput,  true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('submit', onSubmit, true);
  }

  function detenerRecording() {
    isRecording = false;
    if (!recorderHandlers) return [];
    document.removeEventListener('click',  recorderHandlers.onClick,  true);
    document.removeEventListener('input',  recorderHandlers.onInput,  true);
    document.removeEventListener('change', recorderHandlers.onChange, true);
    document.removeEventListener('submit', recorderHandlers.onSubmit, true);
    recorderHandlers = null;
    const result = recordedActions;
    recordedActions = [];
    console.log('[Edy] detenerRecording:', result.length, 'acciones grabadas');
    return result;
  }

  // Start recording immediately on page load by checking storage directly.
  // This avoids the background roundtrip race: clicks on a new page happen before
  // content_script_listo response arrives, causing early events to be missed.
  if (isContextValid()) {
    chrome.storage.local.get(['estado_agente', 'acciones_grabadas'], ({ estado_agente, acciones_grabadas }) => {
      console.log('[Edy] storage check on load — estado_agente:', estado_agente);
      if (estado_agente === 'observando') {
        iniciarRecording();
        widget.resetObservando();
        widget.mostrarEstado('observando');
      } else if (estado_agente === 'idle' && (acciones_grabadas || []).length > 0) {
        const n = (acciones_grabadas || []).length;
        widget.setResumenAprendido(n + ' acciones · listo para ejecutar');
        widget.mostrarEstado('aprendido');
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SEMANTIC FIELD IDENTIFICATION  (used by background during execution)
  // ─────────────────────────────────────────────────────────────────────────────

  window.edyEncontrarElemento = function ({
    etiqueta      = '',
    placeholder   = '',
    ariaLabel     = '',
    tipo          = '',
    selectorAyuda = '',
    texto         = '',
    contexto      = '',
    aliases       = [],
  } = {}) {
    const scores = new Map();
    const add = (el, pts) => {
      if (!el || !document.contains(el)) return;
      scores.set(el, (scores.get(el) || 0) + pts);
    };

    const etiquetas = expandirAliasesCampo([etiqueta, placeholder, ariaLabel, texto, ...aliases]);

    if (selectorAyuda) { try { add(document.querySelector(selectorAyuda), 2); } catch {} }

    for (const candidato of etiquetas) {
      const pl = candidato.toLowerCase();
      document.querySelectorAll('input, textarea').forEach(el => {
        const ph = (el.placeholder || '').toLowerCase();
        if (ph === pl) add(el, 10); else if (ph.includes(pl) || pl.includes(ph)) add(el, 5);
      });
    }

    for (const candidato of etiquetas) {
      const al = candidato.toLowerCase();
      document.querySelectorAll('[aria-label]').forEach(el => {
        const v = (el.getAttribute('aria-label') || '').toLowerCase();
        if (v === al) add(el, 10); else if (v.includes(al) || al.includes(v)) add(el, 5);
      });
    }

    for (const candidato of etiquetas) {
      const etiquetaActual = candidato;
      if (!etiquetaActual) continue;
      const eq = etiquetaActual.toLowerCase();
      document.querySelectorAll('label').forEach(lbl => {
        const clon = lbl.cloneNode(true);
        clon.querySelectorAll('input, select, textarea').forEach(i => i.remove());
        const lt = (clon.innerText || '').trim().toLowerCase();
        if (!lt) return;
        const pts = lt === eq ? 10 : lt.includes(eq) ? 6 : (eq.includes(lt) && lt.length > 3) ? 4 : 0;
        if (pts > 0) {
          const target = lbl.control || (lbl.htmlFor ? document.getElementById(lbl.htmlFor) : null) || lbl.querySelector('input, textarea, select');
          add(target, pts);
        }
      });
      document.querySelectorAll('input, textarea, select').forEach(el => {
        const ph  = (el.placeholder || '').toLowerCase();
        const al2 = (el.getAttribute('aria-label') || '').toLowerCase();
        if (ph.includes(eq))  add(el, 7);
        if (al2.includes(eq)) add(el, 8);
      });
      const esClickable = !tipo || ['button','submit','a','link','click'].includes(tipo);
      if (esClickable) {
        document.querySelectorAll('button, [type="submit"], [role="button"], a').forEach(el => {
          const t = (el.innerText || '').trim().toLowerCase();
          if (t === eq) add(el, 10); else if (t.includes(eq) || eq.includes(t)) add(el, 5);
        });
      }
    }

    // If we have the product name as context, narrow to buttons near that product
    if (contexto && (tipo === 'click' || !tipo)) {
      const ctx = contexto.toLowerCase();
      document.querySelectorAll('button, [role="button"], [data-test]').forEach(el => {
        const card = el.closest(
          '[class*="item"], [class*="product"], [class*="card"], [class*="inventory"], li, article, tr'
        );
        if (!card) return;
        const cardText = (card.innerText || '').toLowerCase();
        if (cardText.includes(ctx)) add(el, 15);
      });
    }

    // Button text matching as fallback
    if (texto) {
      const t = texto.toLowerCase();
      document.querySelectorAll('button, [role="button"], a, input[type="submit"]').forEach(el => {
        const bt = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
        if (bt === t) add(el, 8); else if (bt.includes(t)) add(el, 4);
      });
    }

    if (scores.size === 0) return null;
    return [...scores.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };

  function expandirAliasesCampo(valores) {
    const base = new Set();
    valores
      .flat()
      .filter(Boolean)
      .forEach(v => {
        base.add(String(v).trim());
        base.add(normalizarCampo(v));
      });

    const grupos = [
      ['product name', 'product_name', 'product', 'producto', 'nombre producto', 'nombre del producto', 'nombre articulo', 'nombre del articulo', 'articulo', 'item name', 'item_name'],
      ['price', 'unit price', 'unit_price', 'precio', 'precio unitario', 'precio_unitario', 'costo', 'costo unitario', 'costo_unitario'],
      ['quantity', 'qty', 'cantidad', 'unidades'],
      ['zip code', 'zip_code', 'zipcode', 'postal code', 'postal_code', 'codigo postal', 'codigo_postal', 'cp'],
      ['customer', 'customer name', 'cliente', 'nombre cliente', 'nombre_cliente'],
      ['sku', 'codigo sku', 'codigo_sku', 'codigo producto', 'codigo_producto', 'product code', 'product_code'],
    ];

    for (const grupo of grupos) {
      if (grupo.some(alias => base.has(alias))) {
        grupo.forEach(alias => base.add(alias));
      }
    }

    return [...base].filter(Boolean);
  }

  function normalizarCampo(valor) {
    return String(valor || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  window.edyEjecutarAccion = async function ({
    tipo        = 'click',
    selector    = '',
    valor       = '',
    nombreCampo = '',
    etiqueta    = '',
    texto       = '',
    contexto    = '',
    aliases     = [],
  } = {}) {
    let el = selector ? document.querySelector(selector) : null;
    if (!el) {
      el = window.edyEncontrarElemento({ etiqueta: etiqueta || nombreCampo, tipo, selectorAyuda: selector, texto, contexto, aliases });
    }
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(120);
    if (tipo === 'input' || tipo === 'change') {
      el.focus();
      const proto  = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, valor); else el.value = valor;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (tipo === 'submit') {
      el.closest('form')?.requestSubmit?.() ?? el.click();
    } else {
      el.click();
    }
    return true;
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // WIDGET ↔ BACKGROUND
  // ─────────────────────────────────────────────────────────────────────────────

  widget.onObservar(() => {
    widget.resetObservando();
    widget.mostrarEstado('observando');
    sendMsg({ tipo: 'iniciar_grabacion' });
  });

  widget.onDetener(() => {
    sendMsg({ tipo: 'detener_grabacion' });
    // UI will update when grabacion_detenida arrives from background
  });

  widget.onEjecutar(async () => {
    await renderPasosEnEjecucion('Iniciando automatización…');
    widget.mostrarEstado('ejecutando');
    sendMsg({ tipo: 'iniciar_ejecucion' });
  });

  widget.onReejecutar(async () => {
    await renderPasosEnEjecucion('Reiniciando automatización…');
    widget.mostrarEstado('ejecutando');
    sendMsg({ tipo: 'volver_a_ejecutar' });
  });

  widget.onDashboard(() => {
    sendMsg({ tipo: 'abrir_dashboard' });
  });

  widget.onPausar(() => {
    widget.mostrarEstado('aprendido');
  });

  widget.onNuevo(() => {
    // widget already switched to idle via btn-nuevo listener; nothing extra needed
  });

  // ─── Messages from background ────────────────────────────────────────────────
  let wasExecuting = false;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg?.tipo) return;

    switch (msg.tipo) {
      case 'iniciar_grabacion_tab':
        iniciarRecording();
        sendResponse({ ok: true });
        break;

      case 'detener_grabacion_tab': {
        const acciones = detenerRecording();
        sendResponse({ ok: true, acciones });
        break;
      }

      case 'grabacion_iniciada':
        iniciarRecording();
        widget.resetObservando();
        widget.mostrarEstado('observando');
        break;

      case 'grabacion_detenida':
        detenerRecording();
        if ((msg.totalAcciones || 0) > 0) {
          widget.setResumenAprendido(msg.totalAcciones + ' acciones · listo para ejecutar');
          widget.mostrarEstado('aprendido');
        } else {
          widget.mostrarEstado('idle');
        }
        break;

      case 'estado_agente':
        if (msg.estado === 'observando') {
          wasExecuting = false;
          widget.mostrarEstado('observando');
          iniciarRecording();
        } else if (msg.estado === 'ejecutando') {
          wasExecuting = true;
          renderPasosEnEjecucion('Ejecutando automatización…').then(() => widget.mostrarEstado('ejecutando'));
        } else {
          if (wasExecuting) {
            wasExecuting = false;
            widget.mostrarEstado('completado');
          } else {
            widget.mostrarEstado('idle');
            detenerRecording();
          }
        }
        break;

      case 'orden_actual':
        widget.setOrdenInfo?.('Orden #' + msg.orden);
        break;

      case 'campo_detectado':
        widget.agregarCampoDetectado(msg.nombre, msg.time);
        break;

      case 'paso_actual':
        widget.marcarPasoActual(msg.paso);
        break;

      case 'paso_completado':
        widget.marcarPasoCompletado(msg.paso);
        break;

      case 'ejecucion_completada':
        wasExecuting = false;
        widget.mostrarEstado('completado');
        break;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // INIT — sync widget with background state on page load
  // ─────────────────────────────────────────────────────────────────────────────

  if (isContextValid()) {
    chrome.runtime.sendMessage({ tipo: 'content_script_listo' }, (resp) => {
      if (chrome.runtime.lastError || !resp) return;
      // Storage check already set up recording — don't let a slow background
      // response downgrade the widget back to idle.
      if (isRecording) return;
      if (resp.estado === 'observando') {
        widget.mostrarEstado('observando');
        iniciarRecording();
      } else if (resp.estado === 'ejecutando') {
        wasExecuting = true;
        renderPasosEnEjecucion('Ejecutando automatización…').then(() => widget.mostrarEstado('ejecutando'));
      } else if ((resp.totalAcciones || 0) > 0) {
        widget.setResumenAprendido(resp.totalAcciones + ' acciones · listo para ejecutar');
        widget.mostrarEstado('aprendido');
      } else {
        widget.mostrarEstado('idle');
      }
    });
  }
})();
