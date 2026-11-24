/* =====================================================================
   AGENTE DEL REPORTE — parte del navegador (ventana de chat).

   Este archivo es IDÉNTICO en los 3 repositorios (dashboard-compras,
   reporte-proveedores, tablero-compras). Si lo cambias en uno, copia el
   mismo archivo a los otros dos.

   Uso en index.html, justo DESPUÉS de fuente-comun.js:
     <script src="agente.js" data-titulo="…" data-color="#1f5f99"
             data-tema="claro|oscuro|auto" data-sugerencias="pregunta 1|pregunta 2"></script>

   - Muestra el botón "Pregúntale al agente" y la ventana de conversación.
   - Envía las preguntas a /api/agente (el Worker guarda la clave de Claude).
   - Ejecuta aquí, en el navegador, las consultas que pide el agente sobre el
     Excel "Seguimiento de Solpeds" que la página ya descargó (no lo vuelve a
     descargar: reutiliza la misma descarga de FuenteComun.cargar()).
   ===================================================================== */
(function () {
  'use strict';
  if (window.AgenteReporte) return;

  var SCRIPT = document.currentScript || {};
  var ds = SCRIPT.dataset || {};
  var CFG = {
    titulo: ds.titulo || 'Agente del reporte',
    color: ds.color || '#1f5f99',
    tema: ds.tema === 'oscuro' || (ds.tema === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'oscuro' : 'claro',
    sugerencias: (ds.sugerencias || '').split('|').map(function (s) { return s.trim(); }).filter(Boolean),
    api: ds.api || 'api/agente',
  };
  var MAX_RONDAS = 10;            // consultas encadenadas por pregunta
  var MAX_RESULTADO = 12000;      // caracteres por resultado de herramienta
  var MAX_TEXTO_PAGINA = 12000;   // caracteres del texto visible de la página
  var DIA = 86400000;

  /* ---------- 1. Datos: reutiliza la descarga de la página ---------- */
  var ultimaCarga = null;   // promesa de la última llamada a FuenteComun.cargar()
  if (window.FuenteComun && typeof window.FuenteComun.cargar === 'function') {
    var cargarOriginal = window.FuenteComun.cargar;
    window.FuenteComun.cargar = function () {
      var p = cargarOriginal.apply(this, arguments);
      ultimaCarga = p;
      return p;
    };
    window.FuenteComun.cargarOriginal = cargarOriginal;
  }

  var cacheTabla = { F: null, T: null };
  async function obtenerTabla() {
    if (!window.FuenteComun) throw new Error('La página no cargó fuente-comun.js.');
    var F = null;
    try { F = await (ultimaCarga || (ultimaCarga = window.FuenteComun.cargar())); } catch (e) { F = null; }
    if (!F) throw new Error('El Excel compartido no está disponible en esta página. Responde solo con lo visible en la página.');
    if (cacheTabla.F !== F) cacheTabla = { F: F, T: crearTabla(F) };
    return cacheTabla.T;
  }

  function norm(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function crearTabla(F) {
    var porNombre = {};
    var cols = F.encabezados.map(function (nombre, c) {
      var col = F.cols[c] || { t: 'n', v: [] };
      var tipo = { s: 'texto', n: 'numero', d: 'fecha', x: 'mixto' }[col.t] || 'mixto';
      var get;
      if (col.t === 's') get = function (i) { var k = col.v[i]; return k == null ? null : col.dict[k]; };
      else if (col.t === 'd') get = function (i) { var m = col.v[i]; return m == null ? null : new Date(m); };
      else if (col.t === 'x') get = function (i) {
        var x = col.v[i];
        if (x && typeof x === 'object' && '$d' in x) return x.$d == null ? null : new Date(x.$d);
        return x == null || x === '' ? null : x;
      };
      else get = function (i) { var x = col.v[i]; return x == null ? null : x; };
      var info = { nombre: String(nombre || 'Columna ' + (c + 1)), indice: c, tipo: tipo, raw: col, get: get };
      var k = norm(info.nombre);
      if (!(k in porNombre)) porNombre[k] = info;
      return info;
    });
    return { F: F, n: F.n, cols: cols, porNombre: porNombre, esquema: null };
  }

  function columna(T, nombre) {
    var base = String(nombre || '');
    var periodo = null;
    var m = base.match(/^(.*):(anio|año|trimestre|mes|semana|dia|día)$/i);
    if (m) { base = m[1]; periodo = norm(m[2]).replace('ano', 'anio'); }
    var col = T.porNombre[norm(base)];
    if (!col) {
      var parecidas = T.cols.filter(function (c) { return norm(c.nombre).indexOf(norm(base)) >= 0; }).map(function (c) { return c.nombre; });
      throw new Error('No existe la columna "' + base + '".' + (parecidas.length ? ' ¿Quisiste decir: ' + parecidas.slice(0, 5).join(', ') + '?' : ' Columnas: ' + T.cols.map(function (c) { return c.nombre; }).join(', ')));
    }
    return { col: col, periodo: periodo };
  }

  /* ---------- 2. Conversión de valores ---------- */
  function esFecha(v) { return v instanceof Date; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fechaTxt(d) { return isNaN(d) ? null : d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function aNumero(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (esFecha(v)) return v.getTime();
    if (typeof v === 'string') {
      var s = v.replace(/[$\s]/g, '');
      if (/^-?[\d.]+,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, '');
      var n = Number(s);
      return s !== '' && isFinite(n) ? n : null;
    }
    return null;
  }
  function parsearFecha(v, finDelDia) {
    if (v == null) return null;
    var s = String(v).trim();
    var m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?(?:[T ](\d{1,2}):(\d{2}))?/);
    if (m) {
      var y = +m[1], mo = +m[2] - 1, d = m[3] ? +m[3] : 1;
      if (m[4]) return new Date(y, mo, d, +m[4], +m[5]).getTime();
      if (finDelDia) return (m[3] ? new Date(y, mo, d + 1) : new Date(y, mo + 1, 1)).getTime() - 1;
      return new Date(y, mo, d).getTime();
    }
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1] + (finDelDia ? 1 : 0)).getTime() - (finDelDia ? 1 : 0);
    var t = Date.parse(s);
    return isNaN(t) ? null : t;
  }
  function periodoDe(d, p) {
    if (!esFecha(d) || isNaN(d)) return null;
    var y = d.getFullYear();
    if (p === 'anio') return String(y);
    if (p === 'trimestre') return y + '-T' + (Math.floor(d.getMonth() / 3) + 1);
    if (p === 'mes') return y + '-' + pad(d.getMonth() + 1);
    if (p === 'dia') return fechaTxt(d);
    if (p === 'semana') {
      var t = new Date(Date.UTC(y, d.getMonth(), d.getDate()));
      var dia = t.getUTCDay() || 7;
      t.setUTCDate(t.getUTCDate() + 4 - dia);
      var inicio = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
      return t.getUTCFullYear() + '-S' + pad(Math.ceil(((t - inicio) / DIA + 1) / 7));
    }
    return fechaTxt(d);
  }
  function mostrar(v) {
    if (v == null || v === '') return null;
    if (esFecha(v)) {
      if (isNaN(v)) return null;
      return v.getHours() || v.getMinutes() ? fechaTxt(v) + ' ' + pad(v.getHours()) + ':' + pad(v.getMinutes()) : fechaTxt(v);
    }
    if (typeof v === 'number') return Math.round(v * 100) / 100;
    return v;
  }

  /* ---------- 3. Filtros ---------- */
  function predicadoValor(f, col) {
    var op = f.op, val = f.valor;
    var lista = Array.isArray(val) ? val : (val == null ? [] : [val]);
    if (op === 'vacio') return function (v) { return v == null || v === '' || (esFecha(v) && isNaN(v)); };
    if (op === 'no_vacio') return function (v) { return !(v == null || v === '' || (esFecha(v) && isNaN(v))); };
    var esF = col.tipo === 'fecha';
    var esN = col.tipo === 'numero';
    function comparable(v) {
      if (v == null) return null;
      if (esF || esFecha(v)) return esFecha(v) ? v.getTime() : parsearFecha(v);
      if (esN || typeof v === 'number') return aNumero(v);
      return norm(v);
    }
    var numerico = esF || esN;
    function objetivo(x, fin) {
      if (esF) return parsearFecha(x, fin);
      if (esN) return aNumero(x);
      var n = aNumero(x);
      return n;
    }
    switch (op) {
      case 'igual': case 'distinto': case 'en': case 'no_en': {
        var neg = op === 'distinto' || op === 'no_en';
        if (esF) {
          // Igualdad de fecha = mismo día (o mismo mes si se da AAAA-MM)
          var rangos = lista.map(function (x) { return [parsearFecha(x, false), parsearFecha(x, true)]; });
          return function (v) {
            var t = comparable(v);
            var ok = t != null && rangos.some(function (r) { return t >= r[0] && t <= r[1]; });
            return neg ? !ok : ok;
          };
        }
        var textos = lista.map(norm);
        var nums = lista.map(aNumero);
        return function (v) {
          if (v == null) return neg;
          var ok = typeof v === 'number' ? nums.indexOf(v) >= 0 || textos.indexOf(norm(v)) >= 0 : textos.indexOf(norm(esFecha(v) ? fechaTxt(v) : v)) >= 0;
          return neg ? !ok : ok;
        };
      }
      case 'contiene': case 'no_contiene': case 'empieza': {
        var buscados = lista.map(norm);
        return function (v) {
          var t = v == null ? '' : norm(esFecha(v) ? fechaTxt(v) : v);
          var ok = buscados.some(function (b) { return op === 'empieza' ? t.indexOf(b) === 0 : t.indexOf(b) >= 0; });
          return op === 'no_contiene' ? !ok : ok;
        };
      }
      case 'mayor': case 'mayor_igual': case 'menor': case 'menor_igual': case 'entre': {
        var a, b;
        if (op === 'entre') {
          if (lista.length !== 2) throw new Error('"entre" necesita [desde, hasta].');
          a = numerico ? objetivo(lista[0], false) : aNumero(lista[0]);
          b = numerico ? objetivo(lista[1], true) : aNumero(lista[1]);
          if (a == null && !numerico) { a = norm(lista[0]); b = norm(lista[1]); }
        } else {
          a = objetivo(lista[0], op === 'mayor' || op === 'menor_igual');
          if (a == null && !numerico) a = norm(lista[0]);
        }
        if (a == null) throw new Error('Valor no válido para comparar en "' + col.nombre + '": ' + JSON.stringify(val));
        return function (v) {
          var t = comparable(v);
          if (t == null) return false;
          if (typeof a === 'number' && typeof t !== 'number') { t = aNumero(t); if (t == null) return false; }
          if (op === 'mayor') return t > a;
          if (op === 'mayor_igual') return t >= a;
          if (op === 'menor') return t < a;
          if (op === 'menor_igual') return t <= a;
          return t >= a && t <= b;
        };
      }
      default: throw new Error('Operación de filtro desconocida: ' + op);
    }
  }

  function compilarFiltros(T, filtros) {
    if (!filtros) return function () { return true; };
    if (!Array.isArray(filtros)) throw new Error('"filtros" debe ser una lista.');
    var fs = filtros.map(function (f) {
      if (!f || !f.columna || !f.op) throw new Error('Cada filtro necesita "columna" y "op".');
      var col = columna(T, f.columna).col;
      var pred = predicadoValor(f, col);
      if (col.raw.t === 's') {
        // Evalúa el filtro una sola vez por valor distinto (mucho más rápido)
        var ok = col.raw.dict.map(pred);
        var okNulo = pred(null);
        var v = col.raw.v;
        return function (i) { var k = v[i]; return k == null ? okNulo : ok[k]; };
      }
      return function (i) { return pred(col.get(i)); };
    });
    return function (i) {
      for (var j = 0; j < fs.length; j++) if (!fs[j](i)) return false;
      return true;
    };
  }

  function filasQueCumplen(T, filtros) {
    var pasa = compilarFiltros(T, filtros), out = [];
    for (var i = 0; i < T.n; i++) if (pasa(i)) out.push(i);
    return out;
  }

  /* ---------- 4. Herramientas ---------- */
  function limite(v, def, max) { v = parseInt(v, 10); return Math.max(1, Math.min(max, isFinite(v) && v > 0 ? v : def)); }

  function consultar(T, a) {
    var filas = filasQueCumplen(T, a.filtros);
    var grupos = (a.agrupar_por || []).slice(0, 3).map(function (g) { var r = columna(T, g); r.etiqueta = g; return r; });
    var metricas = (a.metricas && a.metricas.length ? a.metricas : [{ op: 'contar' }]).slice(0, 8).map(function (m, k) {
      var op = m.op || 'contar';
      if (['contar', 'contar_distintos', 'suma', 'promedio', 'mediana', 'min', 'max'].indexOf(op) < 0) throw new Error('Métrica desconocida: ' + op);
      if (op !== 'contar' && !m.columna) throw new Error('La métrica "' + op + '" necesita "columna".');
      var c = m.columna ? columna(T, m.columna).col : null;
      var h = m.hasta ? columna(T, m.hasta).col : null;
      var nombre = m.nombre || (op + (m.columna ? ' ' + m.columna : '') + (m.hasta ? ' → ' + m.hasta + ' (días)' : ''));
      return { op: op, col: c, hasta: h, nombre: nombre, k: k };
    });

    function valorMetrica(m, i) {
      if (m.hasta) {
        var d1 = m.col.get(i), d2 = m.hasta.get(i);
        if (!esFecha(d1) || !esFecha(d2) || isNaN(d1) || isNaN(d2)) return null;
        return (d2 - d1) / DIA;
      }
      var v = m.col.get(i);
      if (m.op === 'contar_distintos') return v == null || v === '' ? null : (esFecha(v) ? v.getTime() : v);
      if (m.op === 'min' || m.op === 'max') return esFecha(v) ? (isNaN(v) ? null : v.getTime()) : aNumero(v);
      return aNumero(v);
    }

    var mapa = new Map();
    filas.forEach(function (i) {
      var claves = grupos.map(function (g) {
        var v = g.col.get(i);
        if (g.periodo) return periodoDe(v, g.periodo) || '(vacío)';
        v = mostrar(v);
        return v == null ? '(vacío)' : v;
      });
      var k = JSON.stringify(claves);
      var acc = mapa.get(k);
      if (!acc) {
        acc = { claves: claves, m: metricas.map(function (m) { return { n: 0, s: 0, min: Infinity, max: -Infinity, vals: m.op === 'mediana' ? [] : null, set: m.op === 'contar_distintos' ? new Set() : null }; }) };
        mapa.set(k, acc);
      }
      metricas.forEach(function (m, j) {
        var x = acc.m[j];
        if (m.op === 'contar') { if (!m.col || (m.col.get(i) != null && m.col.get(i) !== '')) x.n++; return; }
        var v = valorMetrica(m, i);
        if (v == null) return;
        if (x.set) { x.set.add(v); return; }
        x.n++; x.s += v;
        if (v < x.min) x.min = v;
        if (v > x.max) x.max = v;
        if (x.vals) x.vals.push(v);
      });
    });

    function resultado(m, x) {
      var esFechaMin = (m.op === 'min' || m.op === 'max') && !m.hasta && m.col.tipo === 'fecha';
      switch (m.op) {
        case 'contar': return x.n;
        case 'contar_distintos': return x.set.size;
        case 'suma': return x.n ? Math.round(x.s * 100) / 100 : null;
        case 'promedio': return x.n ? Math.round((x.s / x.n) * 100) / 100 : null;
        case 'mediana': {
          if (!x.vals.length) return null;
          x.vals.sort(function (p, q) { return p - q; });
          var h = x.vals.length >> 1;
          var med = x.vals.length % 2 ? x.vals[h] : (x.vals[h - 1] + x.vals[h]) / 2;
          return Math.round(med * 100) / 100;
        }
        case 'min': return x.n ? (esFechaMin ? fechaTxt(new Date(x.min)) : Math.round(x.min * 100) / 100) : null;
        case 'max': return x.n ? (esFechaMin ? fechaTxt(new Date(x.max)) : Math.round(x.max * 100) / 100) : null;
      }
      return null;
    }

    if (!grupos.length && !mapa.size) {
      mapa.set('[]', { claves: [], m: metricas.map(function (m) { return { n: 0, s: 0, min: Infinity, max: -Infinity, vals: m.op === 'mediana' ? [] : null, set: m.op === 'contar_distintos' ? new Set() : null }; }) });
    }
    var columnas = grupos.map(function (g) { return g.etiqueta; }).concat(metricas.map(function (m) { return m.nombre; }));
    var tabla = Array.from(mapa.values()).map(function (acc) {
      return acc.claves.concat(metricas.map(function (m, j) { return resultado(m, acc.m[j]); }));
    });
    var orden = a.ordenar_por ? columnas.map(norm).indexOf(norm(a.ordenar_por)) : -1;
    if (orden < 0) orden = grupos.length ? grupos.length : 0;
    var desc = a.descendente !== false;
    // Si se ordena por la columna de un periodo, por defecto va en orden cronológico
    if (a.descendente == null && orden < grupos.length && grupos[orden] && grupos[orden].periodo) desc = false;
    tabla.sort(function (p, q) {
      var x = p[orden], y = q[orden];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      var r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'es', { numeric: true });
      return desc ? -r : r;
    });
    var max = limite(a.limite, 30, 200);
    var out = { filas_que_cumplen_filtros: filas.length, total_grupos: tabla.length, columnas: columnas, filas: tabla.slice(0, max) };
    if (tabla.length > max) out.nota = 'Se muestran ' + max + ' de ' + tabla.length + ' grupos.';
    return out;
  }

  function verFilas(T, a) {
    var filas = filasQueCumplen(T, a.filtros);
    var cols = (a.columnas && a.columnas.length ? a.columnas.map(function (c) { return columna(T, c).col; }) : T.cols.slice(0, 14));
    if (a.ordenar_por) {
      var oc = columna(T, a.ordenar_por).col, desc = a.descendente !== false;
      var clave = function (i) { var v = oc.get(i); return esFecha(v) ? v.getTime() : (typeof v === 'number' ? v : (v == null ? null : String(v))); };
      filas.sort(function (p, q) {
        var x = clave(p), y = clave(q);
        if (x == null) return 1;
        if (y == null) return -1;
        var r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'es', { numeric: true });
        return desc ? -r : r;
      });
    }
    var max = limite(a.limite, 20, 50);
    return {
      filas_que_cumplen_filtros: filas.length,
      filas: filas.slice(0, max).map(function (i) {
        var o = {};
        cols.forEach(function (c) { var v = mostrar(c.get(i)); if (v != null) o[c.nombre] = v; });
        return o;
      }),
      nota: filas.length > max ? 'Se muestran ' + max + ' de ' + filas.length + ' filas.' : undefined,
    };
  }

  function valoresDistintos(T, a) {
    var col = columna(T, a.columna).col;
    var filas = a.filtros ? filasQueCumplen(T, a.filtros) : null;
    var cuenta = new Map(), b = a.contiene ? norm(a.contiene) : null;
    var n = filas ? filas.length : T.n;
    for (var j = 0; j < n; j++) {
      var i = filas ? filas[j] : j;
      var v = mostrar(col.get(i));
      if (v == null) v = '(vacío)';
      cuenta.set(v, (cuenta.get(v) || 0) + 1);
    }
    var lista = Array.from(cuenta.entries());
    if (b) lista = lista.filter(function (e) { return norm(e[0]).indexOf(b) >= 0; });
    lista.sort(function (p, q) { return q[1] - p[1]; });
    var max = limite(a.limite, 40, 200);
    return {
      columna: col.nombre, valores_distintos: lista.length,
      valores: lista.slice(0, max).map(function (e) { return { valor: e[0], filas: e[1] }; }),
      nota: lista.length > max ? 'Se muestran ' + max + ' de ' + lista.length + ' valores.' : undefined,
    };
  }

  function esquema(T) {
    if (T.esquema) return T.esquema;
    var lineas = T.cols.map(function (c) {
      var raw = c.raw, extra = '';
      if (raw.t === 's') {
        var cuenta = new Array(raw.dict.length).fill(0);
        for (var i = 0; i < raw.v.length; i++) if (raw.v[i] != null) cuenta[raw.v[i]]++;
        var top = raw.dict.map(function (d, k) { return [d, cuenta[k]]; }).filter(function (e) { return e[0] !== ''; })
          .sort(function (p, q) { return q[1] - p[1]; });
        var cuantos = raw.dict.length <= 20 ? 20 : 4;
        extra = raw.dict.length + ' valores distintos; ' + (raw.dict.length <= 20 ? 'valores: ' : 'ej.: ') +
          top.slice(0, cuantos).map(function (e) { return '"' + String(e[0]).slice(0, 40) + '"'; }).join(', ');
      } else {
        var min = Infinity, max = -Infinity, vacios = 0;
        for (var j = 0; j < T.n; j++) {
          var v = c.get(j);
          var x = esFecha(v) ? v.getTime() : aNumero(v);
          if (x == null || isNaN(x)) { vacios++; continue; }
          if (x < min) min = x;
          if (x > max) max = x;
        }
        if (min !== Infinity) {
          extra = c.tipo === 'fecha' ? 'desde ' + fechaTxt(new Date(min)) + ' hasta ' + fechaTxt(new Date(max))
            : 'mín ' + (Math.round(min * 100) / 100) + ', máx ' + (Math.round(max * 100) / 100);
          extra += vacios ? '; ' + vacios + ' vacíos' : '';
        } else extra = 'sin valores';
      }
      return '- ' + c.nombre + ' (' + c.tipo + '): ' + extra;
    });
    T.esquema = 'Excel "' + (T.F.archivo || 'Seguimiento de Solpeds') + '", hoja "' + (T.F.hoja || '') + '": ' + T.n + ' filas' +
      (T.F.publicado ? ', publicado ' + fechaTxt(new Date(T.F.publicado)) : '') + '. Columnas:\n' + lineas.join('\n');
    return T.esquema;
  }

  async function ejecutarHerramienta(nombre, args) {
    var T = await obtenerTabla();
    args = args || {};
    if (nombre === 'consultar') return consultar(T, args);
    if (nombre === 'ver_filas') return verFilas(T, args);
    if (nombre === 'valores_distintos') return valoresDistintos(T, args);
    throw new Error('Herramienta desconocida: ' + nombre);
  }

  /* ---------- 5. Contexto de la página ---------- */
  function textoPagina() {
    var partes = [];
    Array.prototype.forEach.call(document.body.children, function (el) {
      if (el === raiz || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) return;
      var t = el.innerText;
      if (t) partes.push(t);
    });
    var t = partes.join('\n').replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    return t.length > MAX_TEXTO_PAGINA ? t.slice(0, MAX_TEXTO_PAGINA) + '\n[… texto de la página recortado]' : t;
  }

  async function contexto() {
    var partes = ['Reporte: ' + document.title + ' (' + location.origin + location.pathname + ')'];
    try { partes.push('Estructura de los datos:\n' + esquema(await obtenerTabla())); }
    catch (e) { partes.push('Datos: ' + e.message); }
    partes.push('Texto visible de la página ahora mismo:\n' + textoPagina());
    return partes.join('\n\n');
  }

  /* ---------- 6. Conversación ---------- */
  var mensajes = [];
  var ocupado = false;

  function recortarHistorial() {
    // Quita preguntas antiguas completas si la conversación crece demasiado
    while (mensajes.length > 40 || JSON.stringify(mensajes).length > 300000) {
      var k = -1;
      for (var i = 1; i < mensajes.length; i++) {
        if (mensajes[i].role === 'user' && typeof mensajes[i].content === 'string') { k = i; break; }
      }
      if (k < 0) break;
      mensajes = mensajes.slice(k);
    }
  }

  async function llamar(ctx) {
    recortarHistorial();
    var r = await fetch(CFG.api, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mensajes: mensajes, contexto: ctx }),
    });
    var j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (!r.ok || !j || !Array.isArray(j.content)) {
      if (r.status === 404 && !j) throw new Error('El agente todavía no está instalado en este sitio (falta la ruta /api/agente).');
      throw new Error((j && j.error) || 'No se pudo obtener respuesta (HTTP ' + r.status + ').');
    }
    return j;
  }

  var ETIQUETAS = { consultar: 'Calculando con los datos', ver_filas: 'Revisando el detalle', valores_distintos: 'Buscando valores' };

  async function preguntar(texto) {
    var inicio = mensajes.length;
    mensajes.push({ role: 'user', content: texto });
    var estado = agregarEstado('Pensando…');
    try {
      var ctx = await contexto();
      for (var ronda = 0; ronda < MAX_RONDAS; ronda++) {
        var r = await llamar(ctx);
        mensajes.push({ role: 'assistant', content: r.content });
        var usos = r.content.filter(function (b) { return b.type === 'tool_use'; });
        if (r.stop_reason !== 'tool_use' || !usos.length) {
          var respuesta = r.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n\n').trim();
          estado.remove();
          agregarMensaje('agente', respuesta || 'No obtuve una respuesta. Intenta preguntar de otra forma.');
          return;
        }
        var resultados = [];
        for (var u = 0; u < usos.length; u++) {
          estado.querySelector('span').textContent = (ETIQUETAS[usos[u].name] || 'Consultando') + '…';
          var res;
          try {
            var salida = await ejecutarHerramienta(usos[u].name, usos[u].input);
            var txt = JSON.stringify(salida);
            if (txt.length > MAX_RESULTADO) txt = txt.slice(0, MAX_RESULTADO) + '… [resultado recortado: pide menos filas o columnas]';
            res = { type: 'tool_result', tool_use_id: usos[u].id, content: txt };
          } catch (e) {
            res = { type: 'tool_result', tool_use_id: usos[u].id, content: 'Error: ' + e.message, is_error: true };
          }
          resultados.push(res);
        }
        mensajes.push({ role: 'user', content: resultados });
        estado.querySelector('span').textContent = 'Analizando…';
      }
      // Demasiadas consultas: pide la respuesta con lo que ya tiene
      mensajes.push({ role: 'assistant', content: [{ type: 'text', text: '(Límite de consultas alcanzado.)' }] });
      mensajes.push({ role: 'user', content: 'Responde ahora con lo que ya averiguaste, sin hacer más consultas.' });
      var fin = await llamar(ctx);
      mensajes.push({ role: 'assistant', content: fin.content });
      estado.remove();
      agregarMensaje('agente', fin.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n\n') || 'No pude completar el análisis. Intenta con una pregunta más específica.');
    } catch (e) {
      mensajes = mensajes.slice(0, inicio);  // deja la conversación como estaba
      estado.remove();
      agregarMensaje('error', e.message || String(e));
      entrada.value = texto;
    }
  }

  /* ---------- 7. Markdown mínimo para las respuestas ---------- */
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function enLinea(s) {
    return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:]|$)/g, '$1<em>$2</em>');
  }
  function markdown(t) {
    var lineas = String(t).replace(/\r/g, '').split('\n'), html = [], i = 0;
    function celdas(l) { return l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); }); }
    while (i < lineas.length) {
      var l = lineas[i];
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lineas.length && /^\s*\|?\s*:?-{2,}/.test(lineas[i + 1])) {
        var cab = celdas(l); i += 2;
        var cuerpo = [];
        while (i < lineas.length && /^\s*\|.*\|\s*$/.test(lineas[i])) { cuerpo.push(celdas(lineas[i])); i++; }
        var num = cab.map(function (_, c) { return cuerpo.length > 0 && cuerpo.every(function (f) { return !f[c] || /^[-$\s\d.,%]+$/.test(f[c]); }); });
        html.push('<div class="ag-tabla"><table><thead><tr>' + cab.map(function (c, k) { return '<th' + (num[k] ? ' class="n"' : '') + '>' + enLinea(c) + '</th>'; }).join('') +
          '</tr></thead><tbody>' + cuerpo.map(function (f) { return '<tr>' + cab.map(function (_, k) { return '<td' + (num[k] ? ' class="n"' : '') + '>' + enLinea(f[k] || '') + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>');
        continue;
      }
      var h = l.match(/^\s*#{1,6}\s+(.*)$/);
      if (h) { html.push('<p class="ag-h">' + enLinea(h[1]) + '</p>'); i++; continue; }
      if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) {
        var ord = /^\s*\d+[.)]/.test(l), items = [];
        while (i < lineas.length && /^\s*([-*•]|\d+[.)])\s+/.test(lineas[i])) { items.push(lineas[i].replace(/^\s*([-*•]|\d+[.)])\s+/, '')); i++; }
        html.push((ord ? '<ol>' : '<ul>') + items.map(function (x) { return '<li>' + enLinea(x) + '</li>'; }).join('') + (ord ? '</ol>' : '</ul>'));
        continue;
      }
      if (!l.trim()) { i++; continue; }
      var par = [];
      while (i < lineas.length && lineas[i].trim() && !/^\s*(\||#|[-*•]\s|\d+[.)]\s)/.test(lineas[i])) { par.push(lineas[i]); i++; }
      if (!par.length) { par.push(l); i++; }
      html.push('<p>' + par.map(enLinea).join('<br>') + '</p>');
    }
    return html.join('');
  }

  /* ---------- 8. Interfaz ---------- */
  var raiz, panel, lista, entrada, botonEnviar, boton;

  function agregarMensaje(tipo, texto) {
    var div = document.createElement('div');
    div.className = 'ag-msg ag-' + tipo;
    if (tipo === 'agente') div.innerHTML = markdown(texto);
    else div.textContent = texto;
    lista.appendChild(div);
    var vacio = lista.querySelector('.ag-vacio');
    if (vacio) vacio.remove();
    lista.scrollTop = lista.scrollHeight;
    return div;
  }
  function agregarEstado(texto) {
    var div = document.createElement('div');
    div.className = 'ag-estado';
    div.innerHTML = '<i></i><i></i><i></i><span></span>';
    div.querySelector('span').textContent = texto;
    lista.appendChild(div);
    lista.scrollTop = lista.scrollHeight;
    return div;
  }
  function pantallaInicial() {
    lista.innerHTML = '';
    var v = document.createElement('div');
    v.className = 'ag-vacio';
    v.innerHTML = '<p><strong>Pregúntame sobre este reporte.</strong> Puedo calcular totales, comparar proveedores, compradores o periodos y mostrarte el detalle de SOLPED y órdenes de compra.</p>';
    if (CFG.sugerencias.length) {
      var cont = document.createElement('div');
      cont.className = 'ag-sugerencias';
      CFG.sugerencias.forEach(function (s) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = s;
        b.addEventListener('click', function () { enviar(s); });
        cont.appendChild(b);
      });
      v.appendChild(cont);
    }
    lista.appendChild(v);
  }

  async function enviar(texto) {
    texto = String(texto || '').trim();
    if (!texto || ocupado) return;
    ocupado = true;
    botonEnviar.disabled = true;
    entrada.value = '';
    ajustarAltura();
    agregarMensaje('yo', texto);
    try { await preguntar(texto); }
    finally { ocupado = false; botonEnviar.disabled = false; entrada.focus(); }
  }
  function ajustarAltura() { entrada.style.height = 'auto'; entrada.style.height = Math.min(entrada.scrollHeight, 140) + 'px'; }

  function abrir(si) {
    panel.hidden = !si;
    boton.hidden = si;
    if (si) { if (!lista.children.length) pantallaInicial(); setTimeout(function () { entrada.focus(); }, 30); obtenerTabla().catch(function () {}); }
    else boton.focus();
  }

  var ICONO = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm3 6.5a1.5 1.5 0 1 0 0 .01zm5 0a1.5 1.5 0 1 0 0 .01zm5 0a1.5 1.5 0 1 0 0 .01z"/></svg>';

  function estilos() {
    var o = CFG.tema === 'oscuro';
    var css = '#agente-raiz{--ag-acento:' + CFG.color + ';--ag-fondo:' + (o ? '#122236' : '#ffffff') + ';--ag-fondo2:' + (o ? '#0c1a2b' : '#f3f5f7') +
      ';--ag-tinta:' + (o ? '#e8f0f7' : '#14232e') + ';--ag-suave:' + (o ? '#9db2c6' : '#5b6b76') + ';--ag-linea:' + (o ? '#27415e' : '#d9e0e5') +
      ';font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ag-tinta);position:fixed;right:20px;bottom:20px;z-index:2147483000}' +
      '#agente-raiz *{box-sizing:border-box;font-family:inherit;letter-spacing:normal;text-transform:none}' +
      '#agente-raiz [hidden]{display:none!important}' +
      '#agente-raiz .ag-boton{display:flex;align-items:center;gap:8px;border:0;border-radius:999px;padding:12px 18px;background:var(--ag-acento);color:#fff;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25)}' +
      '#agente-raiz .ag-boton:hover{filter:brightness(1.08)}' +
      '#agente-raiz button:focus-visible,#agente-raiz textarea:focus-visible{outline:2px solid var(--ag-acento);outline-offset:2px}' +
      '#agente-raiz .ag-panel{width:420px;height:min(640px,calc(100vh - 40px));display:flex;flex-direction:column;background:var(--ag-fondo);border:1px solid var(--ag-linea);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.28);overflow:hidden}' +
      '#agente-raiz header{display:flex;align-items:center;gap:8px;padding:12px 14px;background:var(--ag-acento);color:#fff}' +
      '#agente-raiz header div{flex:1;min-width:0}#agente-raiz header strong{display:block;font-size:15px}#agente-raiz header small{display:block;opacity:.85;font-size:12px}' +
      '#agente-raiz header button{background:rgba(255,255,255,.16);border:0;color:#fff;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer}' +
      '#agente-raiz header button:hover{background:rgba(255,255,255,.28)}' +
      '#agente-raiz .ag-lista{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:var(--ag-fondo2)}' +
      '#agente-raiz .ag-msg{max-width:92%;padding:9px 12px;border-radius:12px;word-wrap:break-word;overflow-wrap:anywhere}' +
      '#agente-raiz .ag-yo{align-self:flex-end;background:var(--ag-acento);color:#fff;white-space:pre-wrap;border-bottom-right-radius:4px}' +
      '#agente-raiz .ag-agente{align-self:flex-start;background:var(--ag-fondo);border:1px solid var(--ag-linea);border-bottom-left-radius:4px}' +
      '#agente-raiz .ag-error{align-self:stretch;background:' + (o ? '#3a1c1c' : '#fdecec') + ';color:' + (o ? '#ffb4b4' : '#9b1c1c') + ';border:1px solid ' + (o ? '#6b2b2b' : '#f3c2c2') + '}' +
      '#agente-raiz .ag-msg p{margin:0 0 8px}#agente-raiz .ag-msg p:last-child{margin-bottom:0}#agente-raiz .ag-h{font-weight:700}' +
      '#agente-raiz .ag-msg ul,#agente-raiz .ag-msg ol{margin:0 0 8px;padding-left:20px}#agente-raiz .ag-msg li{margin:2px 0}' +
      '#agente-raiz .ag-msg code{background:var(--ag-fondo2);padding:1px 4px;border-radius:4px;font-family:ui-monospace,Menlo,monospace;font-size:12px}' +
      '#agente-raiz .ag-tabla{overflow-x:auto;margin:0 0 8px}#agente-raiz table{border-collapse:collapse;width:100%;font-size:12.5px;background:transparent;color:inherit}' +
      '#agente-raiz th,#agente-raiz td{border:0;border-bottom:1px solid var(--ag-linea);padding:5px 6px;text-align:left;vertical-align:top;background:transparent;color:inherit}' +
      '#agente-raiz th{font-weight:600;color:var(--ag-suave);white-space:nowrap}#agente-raiz .n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}' +
      '#agente-raiz .ag-estado{align-self:flex-start;display:flex;align-items:center;gap:4px;color:var(--ag-suave);font-size:13px;padding:4px 2px}' +
      '#agente-raiz .ag-estado i{width:6px;height:6px;border-radius:50%;background:var(--ag-acento);animation:agp 1.2s infinite ease-in-out}' +
      '#agente-raiz .ag-estado i:nth-child(2){animation-delay:.15s}#agente-raiz .ag-estado i:nth-child(3){animation-delay:.3s}#agente-raiz .ag-estado span{margin-left:6px}' +
      '@keyframes agp{0%,80%,100%{opacity:.25;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}' +
      '@media (prefers-reduced-motion:reduce){#agente-raiz .ag-estado i{animation:none}}' +
      '#agente-raiz .ag-vacio{color:var(--ag-suave)}#agente-raiz .ag-vacio p{margin:4px 0 12px}#agente-raiz .ag-vacio strong{color:var(--ag-tinta)}' +
      '#agente-raiz .ag-sugerencias{display:flex;flex-direction:column;gap:6px}' +
      '#agente-raiz .ag-sugerencias button{text-align:left;background:var(--ag-fondo);color:var(--ag-tinta);border:1px solid var(--ag-linea);border-radius:10px;padding:8px 10px;font-size:13px;cursor:pointer}' +
      '#agente-raiz .ag-sugerencias button:hover{border-color:var(--ag-acento)}' +
      '#agente-raiz form{display:flex;gap:8px;align-items:flex-end;padding:10px;border-top:1px solid var(--ag-linea);background:var(--ag-fondo);margin:0}' +
      '#agente-raiz textarea{flex:1;resize:none;min-height:40px;max-height:140px;border:1px solid var(--ag-linea);border-radius:10px;padding:9px 11px;font-size:14px;line-height:1.4;background:var(--ag-fondo2);color:var(--ag-tinta);margin:0}' +
      '#agente-raiz .ag-enviar{border:0;border-radius:10px;background:var(--ag-acento);color:#fff;font-weight:600;padding:0 14px;height:40px;cursor:pointer;font-size:14px}' +
      '#agente-raiz .ag-enviar:disabled{opacity:.5;cursor:default}' +
      '#agente-raiz .ag-nota{margin:0;padding:0 12px 8px;font-size:11px;color:var(--ag-suave);background:var(--ag-fondo)}' +
      '@media (max-width:520px){#agente-raiz{right:10px;bottom:10px;left:auto}#agente-raiz .ag-panel{position:fixed;inset:0;width:auto;height:100%;border-radius:0}}' +
      '@media print{#agente-raiz{display:none!important}}';
    var st = document.createElement('style');
    st.id = 'agente-estilos';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function montar() {
    estilos();
    raiz = document.createElement('div');
    raiz.id = 'agente-raiz';
    raiz.innerHTML =
      '<button type="button" class="ag-boton" aria-haspopup="dialog">' + ICONO + '<span>Pregúntale al agente</span></button>' +
      '<section class="ag-panel" role="dialog" aria-label="' + esc(CFG.titulo) + '" hidden>' +
      '<header><div><strong>' + esc(CFG.titulo) + '</strong><small>Respuestas a partir de los datos de este reporte</small></div>' +
      '<button type="button" class="ag-nueva" title="Empezar una conversación nueva">Nueva</button>' +
      '<button type="button" class="ag-cerrar" aria-label="Cerrar">✕</button></header>' +
      '<div class="ag-lista" aria-live="polite"></div>' +
      '<form><textarea rows="1" placeholder="Escribe tu pregunta…" aria-label="Tu pregunta"></textarea>' +
      '<button type="submit" class="ag-enviar">Enviar</button></form>' +
      '<p class="ag-nota">Respuestas generadas con IA a partir de los datos publicados. Verifica las cifras importantes.</p>' +
      '</section>';
    document.body.appendChild(raiz);
    boton = raiz.querySelector('.ag-boton');
    panel = raiz.querySelector('.ag-panel');
    lista = raiz.querySelector('.ag-lista');
    entrada = raiz.querySelector('textarea');
    botonEnviar = raiz.querySelector('.ag-enviar');

    boton.addEventListener('click', function () { abrir(true); });
    raiz.querySelector('.ag-cerrar').addEventListener('click', function () { abrir(false); });
    raiz.querySelector('.ag-nueva').addEventListener('click', function () {
      if (ocupado) return;
      mensajes = [];
      pantallaInicial();
      entrada.focus();
    });
    raiz.querySelector('form').addEventListener('submit', function (e) { e.preventDefault(); enviar(entrada.value); });
    entrada.addEventListener('input', ajustarAltura);
    entrada.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); enviar(entrada.value); }
    });
    panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') abrir(false); });
  }

  // Muestra el agente solo si el Worker ya tiene la clave de Claude configurada
  function iniciar() {
    fetch(CFG.api, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.activo) montar();
        else console.info('Agente del reporte: no está activo (falta ANTHROPIC_API_KEY en el Worker o la ruta /api/agente).');
      })
      .catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();

  // Para pruebas desde la consola del navegador
  window.AgenteReporte = { ejecutarHerramienta: ejecutarHerramienta, contexto: contexto, abrir: abrir, preguntar: enviar };
})();
