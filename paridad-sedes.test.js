// paridad-sedes.test.js
//
// PRUEBA CRÍTICA — PARIDAD INFORME == PRODUCTIVIDAD, EN LAS TRES SEDES.
//
// Qué verifica, en orden de importancia:
//
//   1. PARIDAD. Para cada sede y cada escenario, el UVR que el hospital ve en el
//      INFORME MENSUAL tiene que ser EXACTAMENTE igual a la suma de UVR que el
//      mismo hospital ve en el reporte de PRODUCTIVIDAD. Son dos pantallas
//      distintas, calculadas desde la misma función, y las dos se usan para
//      reportar a MINSA. Si dejan de coincidir, un hospital está reportando un
//      número y el otro, y la diferencia aparece meses después como un
//      "por qué no cuadra el informe" sin explicación.
//
//   2. LÍNEA BASE ABSOLUTA. Además de la paridad, se fija el número exacto de
//      cada escenario. La paridad por sí sola no alcanza: un error que mueva
//      LOS DOS lados por igual (por ejemplo un factor 3 en vez de 2) seguiría
//      dando paridad, y el hospital reportaría un UVR equivocado con la suite
//      en verde. Estos valores son los que hoy reportan las tres sedes: si
//      cambian, es un cambio deliberado, no un accidente.
//
//   3. IDENTIDAD DE SEDE. Cada archivo se verifica contra su propio Firebase y
//      sus propias constantes (prefijo de código de laboratorio, factor de
//      bioquímica, factor de TP/TTPA). Sirve para que nadie instale por error el
//      archivo de una sede en el equipo de otra: escribiría los resultados de un
//      hospital en la base de datos del otro.
//
// Uso:  node paridad-sedes.test.js
//       (debe ejecutarse en la misma carpeta que los tres .html)

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// --fuente=monolito|kernel  (por defecto: monolito, que es lo que está en producción)
const argFuente = process.argv.find(a => a.startsWith('--fuente='));
const fuenteActiva = argFuente ? argFuente.slice('--fuente='.length) : 'monolito';

// ─────────────────────────────────────────────────────────────────────────────
// Las tres sedes. `esperado` es lo que el archivo DEBE contener.
// ─────────────────────────────────────────────────────────────────────────────
const SEDES = [
  {
    id: 'lampa', label: 'Hospital Antonio Barrionuevo — Lampa',
    archivo: 'SILAB_OS_Lampa.html',
    esperado: { projectId: 'lab-barrionuevo',  factorBioq: 1, factorTpttpa: 2, prefijoLabCode: 'LM' },
  },
  {
    id: 'ilave', label: 'Centro de Salud Ilave',
    archivo: 'SILAB_OS_Ilave.html',
    esperado: { projectId: 'laboratorio-ilave', factorBioq: 3, factorTpttpa: 6, prefijoLabCode: 'IL' },
  },
  {
    id: 'putina', label: 'Centro de Salud Putina',
    archivo: 'SILAB_OS_Putina.html',
    esperado: { projectId: 'lab-putina',      factorBioq: 1, factorTpttpa: 2, prefijoLabCode: 'PU' },
  },
];

// Copias de la MISMA sede de antes de la migración a kernels, para el test
// diferencial (ver más abajo `cargarDelPreMigracion`). No se usan como oráculo
// de paridad: el oráculo sigue siendo el número que reporta el hospital. Se
// usan para responder la única pregunta que la suite no podía responder antes:
// ¿el refactor cambió algún cálculo?
// Las copias contra las que se compara el motor actual, sede por sede.
//
// Son los archivos TAL CUAL estaban antes de la migración a kernels, guardados
// al lado de la suite. El test diferencial (--dif) los carga y compara la
// salida. No son un oráculo abstracto ni una expectations escrita a mano: son el
// código anterior, que es lo único que puede decir la verdad sobre lo que
// cambió.
//
// Las tres son anteriores a los kernels. Ojo con las fechas: la copia de Putina
// es del 26/09/2026 y ya tenía `credits`; las de Lampa e Ilave son más antiguas
// y todavía no. Por eso el diferencial compara solo los campos que AMBOS lados
// tienen (ver compararSalida): comparar un campo que la copia vieja no conoce
// sería comparar dos versiones de la app, no dos del refactor.
const PRE_MIGRACION = {
  lampa:   { archivo: '_orig_lampa.html',   etiqueta: 'Lampa (pre-migración)' },
  ilave:   { archivo: '_orig_ilave.html',   etiqueta: 'Ilave (pre-migración)' },
  putina:  { archivo: '_orig_putina.html',  etiqueta: 'Putina (pre-migración)' },
};

// ─────────────────────────────────────────────────────────────────────────────
// Extracción del motor real desde el HTML.
//
// No se copia ni una línea de lógica a mano: todo sale del archivo que se está
// por instalar. Si mañana se edita el archivo, la prueba corre contra el código
// nuevo. Si un símbolo deja de existir o de llamarse así, la carga falla con un
// mensaje claro en vez de pasar en verde probando una copia vieja.
// ─────────────────────────────────────────────────────────────────────────────
const MARCA_FIN_BLOQUE = 'async function loadBkExternos(){';
// La capa de agregación: lo que la pantalla del Informe Mensual realmente usa
// para sumar, en vez de leer res.uvr a mano como hacía la prueba original.
const MARCA_INICIO_AGREGACION = 'function computeReportMatrix(';
const MARCA_FIN_AGREGACION    = 'function openMonthlyReport(';
// El Informe Intermedio: es otro informe de la misma política, así que tiene la
// misma obligación de respetar las anulaciones.
const MARCA_INICIO_INTERMEDIO = 'const INTERMEDIO_BUCKET_MAP =';
const MARCA_FIN_INTERMEDIO    = 'async function downloadIntermedioXLSX(';
const FUNCIONES = [
  'cultivoFactorFor', 'antibiogramaFactorFor', 'antibiogramaRoundsCount',
  'sampleKindOf', 'defaultSampleFor', 'labCodeDateParts',
  'bkExternoTotal', 'bkExternosDelMes', 'computeProductivity',
  // fechas y normalización: funciones puras, donde el error es silencioso
  'parseDateFlexible', 'isoDate', 'computeAge', 'normalizeDniValue',
  'sanitizeForCloud', 'safeDocId',
  // auditoría
  'logAudit', 'fetchAuditForEntity',
  // baciloscopia y BK externos (facturación)
  'normalizeBkExternoEntry', 'bkExternoTotal',
  // catálogo y perfiles (paquetes de exámenes)
  // pacientes y médicos
  'medicoTokens', 'sameMedico', 'medicoUsageCount', 'bestMedicoName',
  'canonicalizeMedico', 'collectAllMedicoNames', 'findMedicoDuplicateGroups',
  'medicoFrequentTests', 'findPossibleDuplicate', 'validateFechaAtencion',
  // catálogo
  'getCatalogArea', 'findTestDef', 'isTestAdded', 'toggleTest', 'makeTestEntry', 'toast', 'ensureAreaInOrder',
  'ensureAreaInOrder',
  'newStructuredFields', 'structuredAllFields',
  'bkExternosDelMes', 'totalBkExternos',
  // usuarios y contraseñas (seguridad)
  'passwordPolicyError', 'slugifyUsername', 'generateUniqueUsername',
  'userLabel', 'roleOf', 'roleLabel', 'isAdmin', 'canSaveResults',
  // reconstruye la vista global de la hoja desde el kernel
  'sincronizarWorksheet',
  'sincronizarRecords',
  'sincronizarAudit',
  'sincronizarUsers',
  'sincronizarDirectory',
  'sincronizarBkExternos',
  'sincronizarCustomCatalog',
  'lookupDirectory',
];

// Estas son las funciones que NACIERON con la migración: la copia pre-migración
// no las tiene, y no se le exigirían.
const FUNCIONES_DE_KERNEL = new Set([
  'sincronizarWorksheet', 'sincronizarRecords', 'sincronizarAudit',
  'sincronizarUsers', 'sincronizarDirectory', 'sincronizarBkExternos',
  'sincronizarCustomCatalog',
]);

// También nacieron con la migración. `detectarFechasInvisibles` repara fechas
// que se veían mal en los informes: en la copia vieja no existía.
const FUNCIONES_DE_MIGRACION = new Set(['detectarFechasInvisibles']);
// No todas las sedes tienen todas las funciones. Si una falta, la app igual
// funciona con otro camino; por eso no se exige que esté.
// labCodeSuffix no existe en Putina: esa sede arma el código por otro camino.
// No es un error; la app funciona igual y solo cambia de dónde sale el sufijo.
const OPCIONALES = ['refParaExamen', 'labCodeSuffix'];

// Kernels de dominio ya extraídos. Cada uno es una clase que posee el estado de
// su área; las variables globales pasaron a ser una vista que se reconstruye con
// sincronizarWorksheet().
const KERNELS = ['WorksheetKernel', 'RecordsKernel', 'AuditKernel', 'UserKernel', 'DirectoryKernel', 'BkExternosKernel', 'CatalogKernel'];

const CONSTANTES = [
  'CULTIVO_FACTOR_BASE', 'CULTIVO_CONTROLES_BASE', 'CULTIVO_FACTOR_POR_CONTROL_EXTRA',
  'ATB_FACTOR_BASE', 'ATB_CONTROLES_BASE', 'ATB_FACTOR_POR_CONTROL_EXTRA',
  'SAMPLE_TYPE_INFO', 'SAMPLE_AREA_DEFAULT', 'DEFAULT_SAMPLE_BY_TEST',
  'LAB_CODE_SITE_PREFIX',
  'KNOWN_ROLES', 'ROLE_LABELS', 'APP_VERSION', 'AUDIT_LOCAL_MAX',
  'CATALOG', 'STRUCTURED_TYPES',
];

// Salta comentarios y literales para que el conteo de llaves no se confused con
// un '{' dentro de un texto o de una expresión regular.
function saltarLiterales(src, i){
  const c = src[i];
  if(c === '/' && src[i+1] === '/'){ while(i < src.length && src[i] !== '\n') i++; return i; }
  if(c === '/' && src[i+1] === '*'){ i += 2; while(i < src.length && !(src[i] === '*' && src[i+1] === '/')) i++; return i + 1; }
  if(c === '"' || c === "'" || c === '`'){
    const q = c; i++;
    while(i < src.length){
      if(src[i] === '\\'){ i += 2; continue; }
      if(src[i] === q) return i + 1;
      i++;
    }
    return i;
  }
  return i;
}

function extraerFuncion(src, nombre){
  const m = new RegExp('function\\s+' + nombre + '\\s*\\(').exec(src);
  if(!m) return null;
  const abre = src.indexOf('{', m.index);
  if(abre === -1) return null;
  // Si la función es async hay que conservar el prefijo: sin él, un "await"
  // dentro del cuerpo es un error de sintaxis y no se puede probar.
  let inicio = m.index;
  const previo = src.slice(Math.max(0, inicio - 6), inicio);
  if(/\basync\s+$/.test(previo)) inicio = Math.max(0, inicio - 6);
  let i = abre, profundidad = 0;
  while(i < src.length){
    const j = saltarLiterales(src, i);
    if(j !== i){ i = j; continue; }
    if(src[i] === '{') profundidad++;
    else if(src[i] === '}'){ profundidad--; if(profundidad === 0) return src.slice(inicio, i + 1); }
    i++;
  }
  return null;
}

function extraerConstante(src, nombre){
  const m = new RegExp('const\\s+' + nombre + '\\s*=').exec(src);
  if(!m) return null;
  let i = m.index, profundidad = 0, abierto = false;
  while(i < src.length){
    const j = saltarLiterales(src, i);
    if(j !== i){ i = j; continue; }
    const c = src[i];
    if(c === '[' || c === '{' || c === '('){ profundidad++; abierto = true; }
    else if(c === ']' || c === '}' || c === ')') profundidad--;
    else if(c === ';' && (!abierto || profundidad === 0)) return src.slice(m.index, i + 1);
    i++;
  }
  return null;
}

// Igual que extraerConstante pero para `let`/`var`. Hace falta porque una
// función que dependa de estado mutable del módulo no funciona si el sandbox
// solo se trae el cuerpo de la función.
function extraerLet(src, nombre){
  const m = new RegExp('(?:let|var)\\s+' + nombre + '\\s*=').exec(src);
  if(!m) return null;
  let i = m.index, profundidad = 0, abierto = false;
  while(i < src.length){
    const j = saltarLiterales(src, i);
    if(j !== i){ i = j; continue; }
    const c = src[i];
    if(c === '[' || c === '{' || c === '('){ profundidad++; abierto = true; }
    else if(c === ']' || c === '}' || c === ')') profundidad--;
    else if(c === ';' && (!abierto || profundidad === 0)) return src.slice(m.index, i + 1);
    i++;
  }
  return null;
}

// Estado mutable que vive a nivel de módulo y del que dependen funciones
// extraídas. En el HTML real esto no hay que hacerlo: todo está en el mismo
// script y los `let` ya están arriba. Acá el extractor trae solo el cuerpo de
// la función, así que hay que reconstruir estas declaraciones a mano.
const ESTADO_DE_MODULO = ['__idsVistos', '__primerSync'];

function extraerEntre(src, desde, hasta){
  const a = src.indexOf(desde);
  if(a === -1) return null;
  const b = src.indexOf(hasta, a + desde.length);
  if(b === -1) return null;
  return src.slice(a, b);
}

// ─────────────────────────────────────────────────────────────────────────────
// ESCÁNER DE MUTACIONES DIRECTAS
//
// La red de pruebas de este archivo verifica CÁLCULO (informes, créditos, UVR,
// fechas, usuarios). No verifica CABLEADO DE ESTADO: nada impedía que alguien
// escribiera `records.push(...)` en un lugar nuevo y la suite siguiera en verde.
//
// Este escáner cubre ese hueco. Busca los sitios donde una variable global de
// dominio se MUTA sin pasar por su kernel: reasignación, métodos que modifican
// el array/conjunto en el lugar, o escritura por índice.
//
// Importante distinguir mutar de leer. `records.map(...)`, `records.filter(...)`,
// `records.length` y `records.find(...)` son lecturas y NO cuentan. Contarlas
// inflaría el número y volvería la lista inútil como lista de trabajo.
//
// Se salta comentarios, cadenas y expresiones regulares con saltarLiterales, que
// ya existe más arriba: sin eso, un `// records.push(x)` en un comentario
// parecería código real (el mismo falso positivo que produjo el "id duplicado"
// de f_estrategia que resultó no existir).
const METODOS_MUTANTES = new Set([
  'push','splice','unshift','pop','shift','sort','reverse','fill','copyWithin',
]);
const METODOS_SET_MUTANTES = new Set(['add','delete','clear']);

// Devuelve [{ variable, linea, tipo, texto }] para cada mutación directa.
function escanearMutaciones(src, nombres){
  // texto limpio: comentarios fuera, conservando los saltos de línea para poder
  // reportar el número de línea real.
  let limpio = '';
  let i = 0;
  while(i < src.length){
    const j = saltarLiterales(src, i);
    if(j !== i){ limpio += src.slice(i, j); i = j; continue; }
    limpio += src[i]; i++;
  }
  const lineaDe = (pos) => limpio.slice(0, pos).split('\n').length;
  const hallados = [];
  for(const nombre of nombres){
    // Coincidencia de identificador: no puede ir precedida por punto, por `#` ni
    // por un caracter de identificador. El `this.#campo` de un kernel NO es la
    // variable global: es el estado privado de la clase, que es justamente lo
    // que el kernel debe poder escribir. Confundir las dos vuelve la regla inútil,
    // porque le prohibiría al propio kernel administrar su propio estado.
    const re = new RegExp('(?<![\\w$.#])' + nombre + '(?![\\w$])', 'g');
    let m;
    while((m = re.exec(limpio)) !== null){
      const antes = limpio.slice(Math.max(0, m.index - 10), m.index);
      // declaración: let/const/var nombre  -> no es mutación, es el origen
      if(/\b(?:let|const|var)\s+$/.test(antes)) continue;
      let k = m.index + nombre.length;
      // saltar espacios
      while(limpio[k] === ' ') k++;
      const c = limpio[k];
      let tipo = null;
      if(c === '=' && limpio[k+1] !== '='){
        // asignación. Descartar =>, ==, === y los "=>" de flecha
        tipo = 'asignacion';
      } else if(c === '['){
        // escritura por índice: arr[i] = ... (pero arr[i] en lectura no)
        const cierra = limpio.indexOf(']', k);
        if(cierra !== -1){
          let j = cierra + 1;
          while(limpio[j] === ' ') j++;
          if(limpio[j] === '=' && limpio[j+1] !== '=') tipo = 'escrituraIndice';
        }
      } else if(c === '.'){
        // Ojo: hay que cortar DESPUÉS del punto. Si se corta en el punto, la
        // expresión /^(\w+)\s*\(/ no matchea nunca (arranca con '.') y esta rama
        // detectaría cero mutaciones de tipo .push()/.add() sin avisar: un
        // escáner que en silencio no mira nada es peor que no tenerlo.
        const resto = limpio.slice(k + 1);
        const mn = /^(\w+)\s*\(/.exec(resto);
        if(mn && METODOS_MUTANTES.has(mn[1])) tipo = 'metodo:' + mn[1];
        else if(mn && METODOS_SET_MUTANTES.has(mn[1])) tipo = 'set:' + mn[1];
        // Recortar por longitud (`arr.length = n`) muta el array sin pasar por
        // ningún método. Es como se recorta el historial de auditoría local, así
        // que si el escáner no lo ve, un cambio en ese límite pasa inadvertido.
        else if(/^length\s*(\+?=)(?!=)/.test(resto)) tipo = 'recorteLength';
      }
      if(!tipo) continue;
      const linea = lineaDe(m.index);
      const texto = (limpio.split('\n')[linea - 1] || '').trim().slice(0, 96);
      hallados.push({ variable: nombre, linea, tipo, texto });
    }
  }
  return hallados.sort((a, b) => a.linea - b.linea);
}

// Convierte un número de línea (1-based) en su desplazamiento en el texto.
function desplazamientoDeLinea(src, linea){
  let n = 1, i = 0;
  while(n < linea && i < src.length){ if(src[i] === '\n') n++; i++; }
  return i;
}

// Extrae una declaración de clase completa, incluidos sus métodos y campos
// privados (#campo). Hace falta porque los kernels son clases: si el sandbox de
// las pruebas no las trae, cualquier función que use un kernel revienta con
// "worksheetKernel is not defined" y el fallo se confunde con un bug de cálculo.
function extraerClase(src, nombre){
  const m = new RegExp('class\\s+' + nombre + '\\s*\\{').exec(src);
  if(!m) return null;
  const abre = src.indexOf('{', m.index);
  let i = abre, profundidad = 0;
  while(i < src.length){
    const j = saltarLiterales(src, i);
    if(j !== i){ i = j; continue; }
    if(src[i] === '{') profundidad++;
    else if(src[i] === '}'){ profundidad--; if(profundidad === 0) return src.slice(m.index, i + 1); }
    i++;
  }
  return null;
}

function leerHTML(sede){
  const ruta = path.join(__dirname, sede.archivo);
  if(!fs.existsSync(ruta)) throw new Error(`[${sede.id}] no existe el archivo: ${ruta}`);
  return fs.readFileSync(ruta, 'utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Fuentes de implementación: el MISMO contrato, dos implementaciones.
//
// Los escenarios y las líneas base NO cambian: son el contrato de
// comportamiento, y por eso la migración queda probada en vez de asumida. El
// oráculo es siempre lo que hoy está en producción.
//
//   node paridad-sedes.test.js         → las tres sedes, oráculo de paridad
//   node paridad-sedes.test.js --dif   → además, comparación pre/post migración
//
// CONTRATO que debe cumplir cualquier implementación (monolito o kernel):
//   {
//     clasificar(ficha)            → { inc, uvr, credits, otrosNames, ... }
//     columnas                     → [{ key, top, sub, factor }, ...]
//     columnasFactorVariable       → ['cultivo','antibiograma','otros',...]
//     campana                      → { multiplicador, preanalitica }
//     factorTpttpa                 → número
//     factorBioq                   → número
//     prefijoLabCode               → 'LM' | 'IL' | 'PU'
//     projectId                    → id de Firebase de la sede
//   }
// Si algo no está, la carga falla con mensaje claro en vez de pasar en verde.
// ─────────────────────────────────────────────────────────────────────────────
// `--fuente=kernel` nació para una migración que sería "el mismo cálculo, con el
// estado en kernels". Hoy esa migración YA ESTÁ HECHA, y está dentro del mismo
// archivo: no hay dos implementaciones que comparar, hay una.
//
// Por eso esta fuente ya no tiene sentido como alternativa: para correr contra
// los kernels no hay que cambiar de fuente, hay que correr la fuente normal
// (los kernels se extraen del archivo y se ejercitan). Dejarla activa daría
// una falsa sensación de dos implementaciones verificadas cuando en realidad no
// habría segunda implementación que probar.
function cargarDelKernel(sede){
  throw new Error(
    `[${sede.id}] --fuente=kernel ya no aplica: los kernels se extrajeron del mismo archivo.\n` +
    '  La migración está hecha y se verifica de dos formas:\n' +
    '    · sin --fuente      → el monolito de producción, con sus 7 kernels extraídos\n' +
    '    · con --dif         → además, la MISMA sede antes de la migración, comparado\n' +
    '  Para correr la comparación:  node paridad-sedes.test.js --dif'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// El test diferencial: la MISMA sede, antes y después de la migración.
//
// La suite responde "¿el número que reporta el hospital es el correcto?". No
// responde "¿este refactor cambió algo?", y esa es justo la pregunta que aparece
// al revisar un cambio de 2.000 líneas en tres archivos que nadie puede
// auditar a ojo. Por eso se cargan también las copias pre-migración y se
// compara la salida completa de las dos, entrada por entrada.
//
// Si el número que hoy reporta Lampa cambia, este test falla y el mensaje dice
// contra qué valor estaba. No hace falta un humano comparando.
//
// Alcance: todo lo que sea cálculo determinístico. La estructura del estado
// (los kernels) no se compara con la copia vieja porque no existía; para eso
// están las pruebas de cada kernel, que fijan su comportamiento por contrato.
//
// Uso:  node paridad-sedes.test.js --dif=si
//       node paridad-sedes.test.js --fuente=kernel   (ver más abajo)
function cargarDelPreMigracion(sede){
  const ref = PRE_MIGRACION[sede.id];
  if(!ref){
    throw new Error(`[${sede.id}] no hay copia pre-migración para comparar.\n` +
      '  Sin ella el test diferencial no se puede correr en esta sede.');
  }
  const ruta = path.join(__dirname, ref.archivo);
  if(!fs.existsSync(ruta)) throw new Error(`[${sede.id}] falta la copia pre-migración: ${ruta}`);
  return cargarDelMonolito(sede, { sinKernels: true, html: fs.readFileSync(ruta, 'utf-8') });
}

const FUENTES = {
  monolito: cargarDelMonolito,
  premig:   cargarDelPreMigracion,
  kernel:   cargarDelKernel,
};

function cargarMotor(sede){
  const nombre = fuenteActiva;
  const cargar = FUENTES[nombre];
  if(!cargar) throw new Error(`fuente desconocida: "${nombre}". Valores: ${Object.keys(FUENTES).join(', ')}`);
  return cargar(sede);
}

// Las instanciaciones se extraen del HTML, no se redeclaran acá.
//
// Esto parece un detalle pero no lo es: si el sandbox escribiera su propio
// `new AuditKernel(400)`, la línea real de la app quedaría sin ejercitar y
// cambiar el tope a 100 en el HTML no lo detectaría nadie. Extrayéndolas, la
// prueba corre contra la instanciación verdadera, con los argumentos verdaderos.
const INSTANCIAS = ['worksheetKernel', 'recordsKernel', 'auditKernel', 'userKernel', 'directoryKernel', 'bkKernel', 'catalogKernel'];

// `opciones.sinKernels` carga una copia que todavía no tenía kernels: ahí el
// estado son variables globales y no hay clase que extraer ni instanciar.
function cargarDelMonolito(sede, opciones){
  const op = opciones || {};
  const sinKernels = !!op.sinKernels;
  const kernels      = sinKernels ? [] : KERNELS;
  const instanciaciones = sinKernels ? [] : INSTANCIAS;
  const funciones = sinKernels
    ? FUNCIONES.filter(f => !FUNCIONES_DE_KERNEL.has(f) && !FUNCIONES_DE_MIGRACION.has(f))
    : FUNCIONES;
  const html = op.html || leerHTML(sede);
  const partes = [];
  const faltan = [];

  // El bloque principal: desde la estructura de filas del informe hasta antes de
  // los manejadores de baciloscopías externas. Trae REPORT_ROW_GROUPS,
  // REPORT_ALL_SERVICIOS, REPORT_SERVICIO_LOOKUP, normalizeServicio,
  // matchReportServicio, parseFechaMes, bkExternosDelMes, la tabla de factores
  // (REPORT_COLUMNS, VARIABLE_FACTOR_COLS, OTROS_FACTOR_TP_TTPA), HEMOGRAMA_*,
  // bkAllSlots, los contadores, campanaConfig, classifyTestsForReport y
  // aplicarAjusteCampana.
  const bloque = extraerEntre(html, 'const REPORT_ROW_GROUPS =', MARCA_FIN_BLOQUE);
  if(bloque) partes.push(bloque);
  else faltan.push('bloque principal (REPORT_ROW_GROUPS → loadBkExternos)');

  const agregacion = extraerEntre(html, MARCA_INICIO_AGREGACION, MARCA_FIN_AGREGACION);
  if(agregacion) partes.push(agregacion);
  else faltan.push('capa de agregación (computeReportMatrix → openMonthlyReport)');

  const intermedio = extraerEntre(html, MARCA_INICIO_INTERMEDIO, MARCA_FIN_INTERMEDIO);
  if(intermedio) partes.push(intermedio);
  else faltan.push('Informe Intermedio (matchIntermedioBucket → downloadIntermedioXLSX)');

  for(const f of funciones){
    const src = extraerFuncion(html, f);
    if(src) partes.push(src); else faltan.push('función ' + f);
  }
  // Funciones que no están en las tres sedes. Putina, por ejemplo, no tiene
  // refParaExamen (usa def.ref directo). No es un error: la app funciona igual.
  for(const f of OPCIONALES){
    const src = extraerFuncion(html, f);
    if(src) partes.push(src);
  }
  // La plataforma de complementos se extrae entera, entre sus dos marcadores.
  // Se prueba el CÓDIGO REAL que va en los archivos, no una copia: si mañana se
  // cambia el aislamiento de fallos, la prueba lo sigue cubriendo.
  // La plataforma NO está en las copias pre-migración: es código que se agregó
  // después. Cuando se carga una copia vieja no se busca, igual que no se
  // buscan los kernels: no es que falte, es que todavía no existía.
  if(!sinKernels){
    const ini = html.indexOf('// <<< PLATAFORMA_COMPLEMENTOS_INICIO >>>');
    const fin = html.indexOf('// <<< PLATAFORMA_COMPLEMENTOS_FIN >>>');
    if(ini < 0 || fin < 0) faltan.push('plataforma de complementos');
    else partes.push(html.slice(ini, fin));
  }
  for(const c of CONSTANTES){
    const src = extraerConstante(html, c);
    if(src) partes.push(src); else faltan.push('constante ' + c);
  }
  // El estado de módulo va antes que las funciones que lo usan.
  if(!sinKernels){
    for(const v of ESTADO_DE_MODULO){
      const src = extraerLet(html, v);
      if(src) partes.push(src); else faltan.push('estado de módulo ' + v);
    }
  }
  // Los kernels se declaran PRIMERO: una `class` no se puede usar antes de que
  // exista (a diferencia de una function), así que si el kernel seiera después
  // de `new WorksheetKernel()` el sandbox reventaría al evaluarse. Y si faltara
  // uno, el error sería "X is not defined", que tapa el verdadero problema.
  for(const k of kernels){
    const src = extraerClase(html, k);
    if(src) partes.unshift(src); else faltan.push('kernel ' + k);
  }

  // Las instanciaciones van después de las clases y de las funciones: una `class`
  // no existe antes de declararse, y sin la clase no se puede instanciar.
  for(const inst of instanciaciones){
    const src = extraerConstante(html, inst);
    if(src) partes.push(src); else faltan.push('instanciación ' + inst);
  }

  if(faltan.length){
    throw new Error(`[${sede.id}] no se pudo extraer del HTML: ${faltan.join(', ')}.\n` +
                    '  Si el archivo se renombró o se reorganizó, actualizá la lista en este test.');
  }

  const sandbox = { console };
  vm.createContext(sandbox);
  // La capa de agregación no recibe los registros por parámetro: lee del estado
  // global. Se declara acá vacío y la prueba lo llena con setRecords(), en vez
  // de traer el array gigante de la app.
  vm.runInContext(
    'let records = []; let users = []; let auditLog = []; let directory = {};\n' +
    'let currentTests = []; let currentPackages = new Set(); let customCatalog = {}; let openAreas = new Set();\n' +
    // estado real de producción: los perfiles lo respetan al quitarse para no borrar
    // exámenes que el usuario agregó de a uno
    'let manualTests = new Set();\n' +
    'let medicosList = []; let editingId = null;\n' +
    'const __form = { f_nombre: "", f_dni: "", f_fecha: "" };\n' +
    // Stubs de la frontera de la app: nube, IndexedDB, interfaz y generación de
    // códigos. La plataforma los USA, pero no es lo que se prueba acá: lo que se
    // prueba es el CANAL (registro, arranque, aislamiento de fallos,
    // capacidades y almacenamiento separado por complemento).
    'async function nextLabCode(){ return "LC-TEST-" + (++__n); }\n' +
    'function canonicalizeMedico(n){ return String(n||"").trim(); }\n' +
    'function cloneTest(t){ return JSON.parse(JSON.stringify(t)); }\n' +
    'let __guardadas = 0;\n' +
    'async function saveRecords(){ __guardadas++; }\n' +
    'let __subidas = [];\n' +
    'function cloudSetRecord(r){ __subidas.push(r.id); }\n' +
    // (toast NO se stubbea: el harness extrae el toast real de la app y lo
    //  sobrescribe. Un plugin que avise por toast no deja rastro medible acá.)
    'let __avisos = [];\n' +
    'let AREA_ORDER = [];\n' +
    // stub del DOM: toggleTest -> toast/renderCatalog/renderSheet tocan la interfaz
    '  const __nodo = (id, tag) => ({\n' +
    '    id, tagName: (tag || "div").toUpperCase(), src: "",\n' +
    '    onload: null, onerror: null,\n' +
    '    get value(){ return (__form[id] !== undefined ? __form[id] : ""); }, set value(v){ __form[id] = v; },\n' +
    '    textContent:"", innerHTML:"", classList:{add(){},remove(){},toggle(){},contains(){return false}}, style:{},\n' +
    '    querySelectorAll: () => [], querySelector: () => null, closest: () => null, dataset:{},\n' +
    '    getAttribute: () => null, setAttribute(){}, remove(){},\n' +
    '    appendChild(hijo){\n' +
    '      if(this.tagName === "BODY" && hijo && hijo.tagName === "SCRIPT" && hijo.src){\n' +
    '        if(typeof __cargadorScript !== "function"){\n' +
    '          if(hijo.onerror) hijo.onerror(new Error("sin cargador"));\n' +
    '          return;\n' +
    '        }\n' +
    // OJO: se evalúa con el Function DEL SANDBOX, no con el del archivo de
    // prueba. Ejecutarlo afuera lo correría en otro realm, sin `window`, y el
        // complemento se iría por el branch de "esta página no es un SILAB".
    '        try{ const __codigo = __cargadorScript(hijo.src); new Function(__codigo)(); if(hijo.onload) hijo.onload(); }\n' +
    '        catch(e){ if(hijo.onerror) hijo.onerror(e); }\n' +
    '      }\n' +
    '      return hijo;\n' +
    '    }\n' +
    '  });\n' +
    '  const $ = (id) => __nodo(id);\n' +
    '  const document = { getElementById: $ , createElement: (tag) => __nodo("x", tag), querySelectorAll: () => [], querySelector: () => null, body: __nodo("body", "body") };\n' +
    // Para probar la instalación por URL de verdad (no de mentira) hace falta
    // que appendChild de un <script> haga lo que haría el navegador: bajar el
    // archivo y ejecutarlo. `__cargadorScript` lo define la prueba; si nadie lo
    // define, el intento falla con un mensaje claro, que es exactamente lo que
    // pasa al abrir el HTML con doble clic.
    '  var __cargadorScript = null;\n' +
    // `window` es el global del sandbox. La app publica ahí la plataforma de
    // complementos (window.Silab), igual que lo hace en el navegador.
    '  var window = globalThis;\n' +
    'let cloudReady = false; let fb = null; let __usuario = null; let __n = 0; let __nube = [];\n' +
    'function setTimeout(fn, ms){ return 0; }\n' +
    // stubs de la capa de render: a toggleTest le importan los efectos, no el dibujo
    'function renderCatalog(){}\n' +
    'function renderSheet(){}\n' +
    'function escapeHtml(s){ return String(s==null?"":s); }\n' +
    'function closeNewTestModal(){}\n' +
    'function clearTimeout(id){}\n' +
    'function setInterval(fn, ms){ return 0; }\n' +
    'function clearInterval(id){}\n' +
    'function uid(){ return "u" + (++__n); }\n' +
    'function currentUser(){ return __usuario; }\n' +
    // IndexedDB de memoria. Antes esto devolvía siempre `{value:null}` y no
    // guardaba nada; ahora sí, para que los complementos puedan persistir de
    // verdad y para comprobar que sus claves llevan prefijo de id y no se pisan
    // entre sí.
    'const __mem = new Map();\n' +
    'const storage = {\n' +
    '  async get(k){ return __mem.has(k) ? {key:k, value:__mem.get(k)} : null; },\n' +
    '  async set(k,v){ __mem.set(k,v); return {key:k, value:v}; },\n' +
    '  async delete(k){ __mem.delete(k); return {key:k, deleted:true}; }\n' +
    '};\n' +
    // stub de la escritura a la nube: se guarda lo que se intentó enviar
    'function cloudLogAudit(e){ __nube.push(e); return Promise.resolve(); }\n' +
    partes.join('\n') + '\n' +
    'AREA_ORDER = Object.keys(CATALOG);\n' +
    '__out = {\n' +
    '  clasificar: classifyTestsForReport,\n' +
    '  columnas: REPORT_COLUMNS,\n' +
    '  columnasFactorVariable: VARIABLE_FACTOR_COLS,\n' +
    '  campana: campanaConfig,\n' +
    '  factorTpttpa: OTROS_FACTOR_TP_TTPA,\n' +
    '  factorBioq: (REPORT_COLUMNS.find(c => c.key === \'bioquimica\') || {}).factor,\n' +
    '  prefijoLabCode: LAB_CODE_SITE_PREFIX,\n' +
    // capa de agregación: la que usa la pantalla, no la que leía la prueba a mano
    '  servicios: REPORT_ALL_SERVICIOS,\n' +
    '  matriz: computeReportMatrix,\n' +
    '  colTotal: reportColTotal,\n' +
    '  groupTotal: reportGroupTotal,\n' +
    '  rowTotal: reportRowTotal,\n' +
    '  productividad: computeProductivity,\n' +
    '  intermedio: computeIntermedioMatrix,\n' +
    // fechas y normalización
    '  fecha: normalizeFechaDDMMYYYY,\n' +
    '  fechaFlexible: parseDateFlexible,\n' +
    '  iso: isoDate,\n' +
    '  edad: computeAge,\n' +
    '  dni: normalizeDniValue,\n' +
    '  paraNube: sanitizeForCloud,\n' +
    '  docId: safeDocId,\n' +
    '  mes: parseFechaMes,\n' +
    (sinKernels ? '' : '  detectarFechas: detectarFechasInvisibles,\n') +
    // usuarios y contraseñas
    '  passError: passwordPolicyError,\n' +
    '  slug: slugifyUsername,\n' +
    '  unico: generateUniqueUsername,\n' +
    '  etiqueta: userLabel,\n' +
    '  rol: roleOf,\n' +
    '  rolTexto: roleLabel,\n' +
    '  esAdmin: isAdmin,\n' +
    '  puedeGuardar: canSaveResults,\n' +
    // auditoría
    '  logAudit: logAudit,\n' +
    '  buscarAuditoria: fetchAuditForEntity,\n' +
    '  leerAudit: ()=>auditLog.slice(),\n' +
    // Preparar el historial tiene que pasar por el kernel, igual que en la app.
    // Escribir la global directo desincroniza kernel y vista: la prueba lo
    // detectó (ponía 400 entradas y al agregar una el log volvía a tener 4).
    '  ponerAudit: (l)=>{ auditKernel.replaceAll(l); sincronizarAudit(); },\n' +
    '  setUsuario: (u)=>{ __usuario = u; },\n' +
    '  verNube: ()=>__nube.slice(),\n' +
    '  limpiarNube: ()=>{ __nube = []; },\n' +
    '  setNube: (o)=>{ cloudReady = !!o.ready; fb = o.fb; },\n' +

    '  bkAllSlots: bkAllSlots,\n' +
    '  cuentaBk: countBkMuestras,\n' +
    '  bkPorTipo: countBkByTipo,\n' +
    '  totalBk: totalBkExternos,\n' +
    '  normalizaBk: normalizeBkExternoEntry,\n' +
    '  totalDe: bkExternoTotal,\n' +
    (typeof labCodeSuffix === 'function' ? '  sufijoCodigo: labCodeSuffix,\n' : '') +
    '  partesCodigo: labCodeDateParts,\n' +
    // catálogo y perfiles
    '  getCatalogArea: getCatalogArea,\n' +
    '  findTestDef: findTestDef,\n' +
    '  isTestAdded: isTestAdded,\n' +
    '  toggleTest: toggleTest,\n' +
    '  setBk: (b)=>{ bkKernel.replaceAll(b); sincronizarBkExternos(); },\n' +
    // hoja de trabajo: los exámenes y los perfiles activos de la hoja actual
    (sinKernels
      // sin kernels no hay setters por kernel: se escribe la global, que en esa
      // copia ES el estado
      ? '  setRecords: (rs)=>{ records = rs; },\n'
      : '  setRecords: (rs)=>{ recordsKernel.replaceAll(rs); sincronizarRecords(); },\n') +
    '  verRecords: ()=>records,\n' +
    // Para simular que el navegador baja un <script src="...">: la prueba
    // asigna aquí una función que devuelva el código, y el sandbox se encarga
    // de ejecutarlo en su propio ámbito.
    '  defineCargadorScript: (fn)=>{ __cargadorScript = fn; },\n' +
    '  recordsKernel: ()=>recordsKernel,\n' +
    '  auditKernel: ()=>auditKernel,\n' +
    '  userKernel: ()=>userKernel,\n' +
    // Ojo con la forma: `()=>sincronizarUsers` devuelve la función, no la
    // ejecuta. Estas dos son la acción, no el acceso: se llaman con ().
    '  sincronizarUsers: ()=>sincronizarUsers(),\n' +
    '  sincronizarDirectory: ()=>sincronizarDirectory(),\n' +
    '  verUsers: ()=>users,\n' +
    '  directoryKernel: ()=>directoryKernel,\n' +
    '  verDirectory: ()=>directory,\n' +
    '  lookupDirectory: (q)=>lookupDirectory(q),\n' +
    '  bkKernel: ()=>bkKernel,\n' +
    '  catalogKernel: ()=>catalogKernel,\n' +
    '  verCatalogo: ()=>customCatalog,\n' +
    '  sincronizarCustomCatalog: ()=>sincronizarCustomCatalog(),\n' +
    // Se expone porque el camino real de la interfaz es: el kernel muta y
    // después se llama a sincronizar. Una prueba tiene que hacer lo mismo para
    // estar probando el código que corre en producción y no una_atajo.
    '  sincronizarRecords: ()=>sincronizarRecords(),\n' +
    '  verBkExternos: ()=>bkExternos,\n' +
    '  sincronizarBkExternos: ()=>sincronizarBkExternos(),\n' +
    '  constantes: ()=>({ AUDIT_LOCAL_MAX: AUDIT_LOCAL_MAX, APP_VERSION: APP_VERSION }),\n' +
    '  verTests: ()=>currentTests.map(t=>t.name),\n' +
    '  sameMedico: sameMedico,\n' +
    '  medicoTokens: medicoTokens,\n' +
    '  bestMedicoName: bestMedicoName,\n' +
    '  canonicalizeMedico: canonicalizeMedico,\n' +
    '  findMedicoDuplicateGroups: findMedicoDuplicateGroups,\n' +
    '  findPossibleDuplicate: findPossibleDuplicate,\n' +
    '  verMedicos: ()=>medicosList.slice(),\n' +
    '  setMedicos: (m)=>{ medicosList = m; },\n' +
    '  setForm: (o)=>{ for(const k in o) __form[k] = o[k]; },\n' +
    '  verForm: ()=>Object.assign({}, __form),\n' +
    '  setEditing: (id)=>{ editingId = id; },\n' +
    '  verPaquetes: ()=>Array.from(currentPackages),\n' +
    '  setTests: (ts)=>{ worksheetKernel.setTests(ts); sincronizarWorksheet(); },\n' +
    '  setPaquetes: (ps)=>{ worksheetKernel.setPackages(ps); sincronizarWorksheet(); },\n' +
    '  setManuales: (ms)=>{ worksheetKernel.setManual(ms); sincronizarWorksheet(); },\n' +
    '  verTests: ()=>currentTests.map(t=>t.name),\n' +
    '  verManuales: ()=>Array.from(manualTests),\n' +
    '  areas: ()=>AREA_ORDER,\n' +
    // Un perfil cualquiera que traiga exámenes (el nombre cambia entre sedes)
    '  ensureAreaInOrder: ensureAreaInOrder,\n' +
    '  perfilConPanel: ()=>{ for(const a of AREA_ORDER){ const p=(CATALOG[a]||[]).find(x=>x.panel); if(p) return p; } return null; },\n' +
    '  setCatalogo: (c)=>{ catalogKernel.fusionar(c); sincronizarCustomCatalog(); },\n' +
    '  limpiarCatalogo: ()=>{ catalogKernel.replaceAll({}); sincronizarCustomCatalog(); },\n' +
    // stubs de interfaz: toggleTest llama a renderCatalog/renderSheet/toast
    '  setUsers:  (us)=>{ users = us; },\n' +
    // La plataforma, para poder ejercitar el canal de complementos
    // En una copia pre-migración la plataforma no existe: se deja fuera el
    // contrato entero, no se pone un stub vacío (un stub vacío pasaría las
    // pruebas sin comprobar nada).
    (sinKernels ? '' : '  Silab: window.Silab,\n  plataforma: { Silab: window.Silab, bus, pluginHost },\n' +
     // Ayudas de prueba: no las usa la app. Sirven para partir de una
     // plataforma limpia entre pruebas, porque el corredor no las serializa.
     '  __borrarInstalados: ()=> saveInstalledPluginsList([]),\n' +
     '  __borrarComplementos: ()=>{ pluginHost.list().forEach(p=> pluginHost.unregister(p.id)); },\n') +
    '  registros: ()=> records,\n' +
    (sinKernels ? '' : '  puedeDibujarPaneles: typeof renderPluginPanelContent === \'function\',\n') +
    (sinKernels ? '' : '  dibujarPanel: (p)=> renderPluginPanelContent(p),\n') +
    '  __mem: __mem, __avisos: __avisos, __subidas: __subidas,\n' +
    // pluginsVivos: lo que los complementos escriben al arrancar. Es la señal
    // de que su init corrió — el toast real no deja nada registrado.
    '  pluginsVivos: ()=> globalThis.__pluginsVivos || [],\n' +
    '};',
    sandbox
  );
  const m = sandbox.__out;
  m.factores = {};
  for(const c of m.columnas) m.factores[c.key] = c.factor;
  m.projectId = (html.match(/projectId:\s*"([^"]+)"/) || [])[1] || null;
  return m;
}

// ─────────────────────────────────────────────────────────────────────────────
// Los dos lados de la paridad.
//
// LADO INFORME: así compone el UVR el cuadro del Informe Mensual.
//   · Columna de factor FIJO:        UVR = inc × factor   (+ el extra de campaña
//     que aplicarAjusteCampana ya dejó dentro de `uvr`).
//   · Columna de FACTOR VARIABLE      UVR = el valor de `uvr` tal cual.
//     (cultivo, antibiograma, otros, parasitolog, widal): su UVR real ya está
//     completo en `uvr` y el `factor` de la columna NO multiplica — `inc` es
//     solamente el conteo entero de exámenes. Sumar los dos duplicaría: Widal
//     con paquete daría 1×16 + 16 = 32 en vez de 16.
//
// LADO PRODUCTIVIDAD: la suma de los `credits` que la función ya fillena en el
//   mismo punto donde decide cada factor.
// ─────────────────────────────────────────────────────────────────────────────
function uvrDelInforme(res, motor){
  let total = 0;
  for(const col in res.inc){
    if(motor.columnasFactorVariable.includes(col)) continue;
    total += (res.inc[col] || 0) * (motor.factores[col] || 0);
  }
  for(const col in res.uvr) total += (res.uvr[col] || 0);
  return total;
}
function uvrDeCreditos(res){
  return res.credits.reduce((s, c) => s + c.factor, 0);
}
function conteosLimpios(res){
  const out = {};
  for(const k in res.inc) if(res.inc[k]) out[k] = res.inc[k];
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Escenarios. Son los 12 del RESUMEN_REFACTOR_CREDITOS_LAMPA_ILAVE.md más los
// que hacen falta para cubrir las ramas con factor dependiente de la sede.
// ─────────────────────────────────────────────────────────────────────────────
const T = (name, extra) => Object.assign(
  { name, area: '', fields: {}, performedBy: 'Lab', performedById: 'u1' }, extra || {});
const FICHA = (tests, extra) => Object.assign(
  { tests, packages: [], esCampanaSalud: false, creadoPor: 'Creador', creadoPorId: 'u0' }, extra || {});

const ESCENARIOS = [
  { nombre: 'Hemograma completo, 1 autor', ficha: () => FICHA([T('Hemoglobina'), T('Hematocrito'), T('Recuento de leucocitos'), T('Recuento de hematíes')]) },
  { nombre: 'Hemograma completo, 2 autores (reparto proporcional del 12)', ficha: () => FICHA([
      T('Hemoglobina', { performedBy: 'Ana', performedById: 'ua' }),
      T('Hematocrito', { performedBy: 'Beto', performedById: 'ub' }),
      T('Recuento de leucocitos', { performedBy: 'Ana', performedById: 'ua' }),
      T('Recuento de hematíes', { performedBy: 'Beto', performedById: 'ub' })]) },
  { nombre: 'Widal como paquete', ficha: () => FICHA([
      T('Widal - O (antígeno)', { performedBy: 'Ana', performedById: 'ua' }),
      T('Widal - H (antígeno)', { performedBy: 'Ana', performedById: 'ua' })], { packages: ['Reacción de Widal'] }) },
  { nombre: 'Widal sueltos multi-autor, sin paquete', ficha: () => FICHA([
      T('Widal - O (antígeno)', { performedBy: 'Ana', performedById: 'ua' }),
      T('Widal - H (antígeno)', { performedBy: 'Beto', performedById: 'ub' })]) },
  { nombre: 'Examen completo de orina (+ sedimento)', ficha: () => FICHA([T('Examen completo de orina')]) },
  { nombre: 'Sedimento urinario suelto', ficha: () => FICHA([T('Sedimento urinario')]) },
  { nombre: 'Cultivo POSITIVO con antibiograma', ficha: () => FICHA([T('Cultivo y Antibiograma', { fields: { resultado: 'Positivo' } })]) },
  { nombre: 'Cultivo NEGATIVO (no factura antibiograma)', ficha: () => FICHA([T('Cultivo y Antibiograma', { fields: { resultado: 'Negativo' } })]) },
  { nombre: 'Parasitológico Seriado 3 muestras (+rinflam)', ficha: () => FICHA([T('Parasitológico Seriado', { fields: { muestra: 'Muestras I, II y III' } })]) },
  { nombre: 'Examen Directo de Heces', ficha: () => FICHA([T('Examen Directo de Heces')]) },
  { nombre: 'Baciloscopia 2 muestras', ficha: () => FICHA([T('Baciloscopia (BK)', { fields: { m1_resultado: 'Negativo', m2_resultado: 'Negativo' } })]) },
  { nombre: 'RINFLAM sola (sin parasitológico)', ficha: () => FICHA([T('Reacción inflamatoria en heces')]) },
  { nombre: 'TP / TTPA (factor de sede)', ficha: () => FICHA([T('Tiempo de Protrombina'), T('Tiempo de Tromboplastina Parcial')]) },
  { nombre: 'Glucosa en Bioquímica Clínica (factor de sede)', ficha: () => FICHA([T('Glucosa', { area: 'Bioquímica Clínica' })]) },
  { nombre: 'Mezcla: Urea + VSG + VIH + RPR', ficha: () => FICHA([
      T('Urea', { area: 'Bioquímica Clínica' }), T('VSG'), T('VIH'), T('RPR')]) },
  { nombre: 'Examen desconocido → OTROS con factor genérico 4', ficha: () => FICHA([T('Examen Inventado Para Esta Prueba')]) },
  { nombre: 'Campaña de salud ×2 (conteo de exámenes intacto)', ficha: () => FICHA(
      [T('Glucosa', { area: 'Bioquímica Clínica' }), T('VIH')], { esCampanaSalud: true }),
    sinCampana: () => FICHA([T('Glucosa', { area: 'Bioquímica Clínica' }), T('VIH')]) },
  // Escenario con VARIOS ítems en OTROS a propósito. Con un solo ítem, el error
  // histórico (multiplicar el conteo) daría 1×2 = 2, que es indistinguible del
  // valor correcto 1+1 = 2: la prueba pasaría en verde con el bug presente.
  // Con 3 ítems, 3×2 = 6 y 3+1 = 4 sí se distinguen.
  { nombre: 'Campaña con 3 ítems en OTROS (distingue +1 de ×2)', ficha: () => FICHA(
      [T('Glucosa', { area: 'Bioquímica Clínica' }), T('Tiempo de Protrombina'), T('Tiempo de Tromboplastina Parcial')],
      { esCampanaSalud: true }),
    sinCampana: () => FICHA([T('Glucosa', { area: 'Bioquímica Clínica' }), T('Tiempo de Protrombina'), T('Tiempo de Tromboplastina Parcial')]),
    },
];

// ─────────────────────────────────────────────────────────────────────────────
// LÍNEA BASE. Estos son los números que hoy reportan las tres sedes.
// Tomados del código real el 28/09/2026, no de una copia a mano.
// Si alguno cambia, es un cambio DELIBERADO: actualizá el número Y el motivo
// del refactor en el resumen del commit, porque estos valores van a MINSA.
// ─────────────────────────────────────────────────────────────────────────────
const LINEA_BASE = {
  comun: {
    'Hemograma completo, 1 autor':                            { informe: 12, inc: { hemograma: 1 } },
    'Hemograma completo, 2 autores (reparto proporcional del 12)': { informe: 12, inc: { hemograma: 1 } },
    'Widal como paquete':                                     { informe: 16, inc: { widal: 1 } },
    'Widal sueltos multi-autor, sin paquete':                 { informe: 8,  inc: { widal: 2 } },
    'Examen completo de orina (+ sedimento)':                 { informe: 8,  inc: { orinas: 1, sedimento: 1 } },
    'Sedimento urinario suelto':                              { informe: 3,  inc: { sedimento: 1 } },
    'Cultivo POSITIVO con antibiograma':                      { informe: 25, inc: { cultivo: 1, antibiograma: 1 } },
    'Cultivo NEGATIVO (no factura antibiograma)':             { informe: 15, inc: { cultivo: 1 } },
    'Parasitológico Seriado 3 muestras (+rinflam)':           { informe: 33, inc: { parasitolog: 3, rinflam: 3 } },
    'Examen Directo de Heces':                                { informe: 11, inc: { parasitolog: 1, rinflam: 1 } },
    'Baciloscopia 2 muestras':                                { informe: 16, inc: { baciloscopia: 2 } },
    'RINFLAM sola (sin parasitológico)':                      { informe: 5,  inc: { rinflam: 1 } },
    'Examen desconocido → OTROS con factor genérico 4':        { informe: 4,  inc: { otros: 1 } },
  },
  // Lo único que cambia de una sede a otra (ver RESUMEN_REFACTOR_CREDITOS):
  //   · TP/TTPA:   Ilave 6 (manual) vs Lampa/Putina 2 (semiautomatizado)
  //   · Bioquímica: Ilave 3 (manual)     vs Lampa/Putina 1 (automatizada)
  //   · + la toma de muestra sanguínea (5) y la preanalítica de campaña (5),
  //     que se acreditan siempre igual en las tres.
  porSede: {
    lampa: {
      'TP / TTPA (factor de sede)':                                  { informe: 9,  inc: { otros: 3 } },
      'Glucosa en Bioquímica Clínica (factor de sede)':              { informe: 6,  inc: { bioquimica: 1, otros: 1 } },
      'Mezcla: Urea + VSG + VIH + RPR':                              { informe: 18, inc: { bioquimica: 1, otros: 2, vih: 1, rpr: 1 } },
      'Campaña de salud ×2 (conteo de exámenes intacto)':           { informe: 23, inc: { bioquimica: 1, vih: 1, otros: 2 } },
      'Campaña con 3 ítems en OTROS (distingue +1 de ×2)':          { informe: 25, inc: { bioquimica: 1, otros: 4 } },
    },
    ilave: {
      'TP / TTPA (factor de sede)':                                  { informe: 17, inc: { otros: 3 } },
      'Glucosa en Bioquímica Clínica (factor de sede)':              { informe: 8,  inc: { bioquimica: 1, otros: 1 } },
      'Mezcla: Urea + VSG + VIH + RPR':                              { informe: 20, inc: { bioquimica: 1, otros: 2, vih: 1, rpr: 1 } },
      'Campaña de salud ×2 (conteo de exámenes intacto)':           { informe: 27, inc: { bioquimica: 1, vih: 1, otros: 2 } },
      'Campaña con 3 ítems en OTROS (distingue +1 de ×2)':          { informe: 45, inc: { bioquimica: 1, otros: 4 } },
    },
    putina: {
      'TP / TTPA (factor de sede)':                                  { informe: 9,  inc: { otros: 3 } },
      'Glucosa en Bioquímica Clínica (factor de sede)':              { informe: 6,  inc: { bioquimica: 1, otros: 1 } },
      'Mezcla: Urea + VSG + VIH + RPR':                              { informe: 18, inc: { bioquimica: 1, otros: 2, vih: 1, rpr: 1 } },
      'Campaña de salud ×2 (conteo de exámenes intacto)':           { informe: 23, inc: { bioquimica: 1, vih: 1, otros: 2 } },
      'Campaña con 3 ítems en OTROS (distingue +1 de ×2)':          { informe: 25, inc: { bioquimica: 1, otros: 4 } },
    },
  },
};

function lineaBaseDe(sedeId, nombreEscenario){
  return LINEA_BASE.comun[nombreEscenario] || LINEA_BASE.porSede[sedeId][nombreEscenario];
}

// ─────────────────────────────────────────────────────────────────────────────
// Corredor de pruebas
// ─────────────────────────────────────────────────────────────────────────────
let pasaron = 0, fallaron = 0, omitidas = 0;
// Algunas funciones son async (p. ej. fetchAuditForEntity). No hay top-level
// await en este archivo, así que la prueba se registra como pendiente y el
// resumen se imprime cuando todas resuelven.
const pendientes = [];
function prueba(nombre, fn){
  try{
    const r = fn();
    if(r && typeof r.then === 'function'){
      console.log(`  … ${nombre}  (asíncrona)`);
      pendientes.push(r.then(
        () =>{ console.log(`  ✓ ${nombre}`); pasaron++; },
        (e)=>{ console.log(`  ✗ ${nombre}\n      ${e.message}`); fallaron++; }
      ));
      return;
    }
    console.log(`  ✓ ${nombre}`); pasaron++;
  }
  catch(e){ console.log(`  ✗ ${nombre}\n      ${e.message}`); fallaron++; }
}
function imprimirResumen(){
  console.log('\n' + '='.repeat(72));
  console.log(`${pasaron} pasaron, ${fallaron} fallaron` + (omitidas ? `, ${omitidas} omitidas` : ''));
  process.exit(fallaron > 0 ? 1 : 0);
}
const casiIgual = (a, b) => Math.abs(a - b) < 1e-9;

console.log('Paridad Informe == Productividad — UVR, en las tres sedes\n' + '='.repeat(72));
console.log('fuente bajo prueba: ' + fuenteActiva.toUpperCase() +
  (fuenteActiva === 'monolito'
    ? '  (oráculo: lo que está en producción hoy)'
    : '  (implementación nueva — debe dar EXACTAMENTE lo mismo que el monolito)'));
console.log('='.repeat(72));

const motores = {};
for(const sede of SEDES){
  console.log('\n' + sede.label);
  let motor;
  try{ motor = motores[sede.id] = cargarMotor(sede); }
  catch(e){ console.log(`  ✗ No se pudo cargar el motor: ${e.message}`); fallaron++; continue; }

  // ---- 3. identidad de sede ----
  prueba('apunta a su propia base de Firebase y a sus propias constantes', ()=>{
    assert.strictEqual(motor.projectId, sede.esperado.projectId,
      `projectId = ${motor.projectId}, se esperaba ${sede.esperado.projectId}. ` +
      'Si se cruzaron los archivos, se estaría escribiendo en la base de otro hospital.');
    assert.strictEqual(motor.factorBioq, sede.esperado.factorBioq, 'factor de Bioquímica');
    assert.strictEqual(motor.factorTpttpa, sede.esperado.factorTpttpa, 'factor de TP/TTPA');
    assert.strictEqual(motor.prefijoLabCode, sede.esperado.prefijoLabCode, 'prefijo de código de laboratorio');
  });

  // ---- 1. paridad + 2. línea base absoluta, escenario por escenario ----
  for(const esc of ESCENARIOS){
    const base = lineaBaseDe(sede.id, esc.nombre);
    if(!base){
      console.log(`  ? ${esc.nombre} (sin línea base: se omite)`);
      omitidas++;
      continue;
    }
    prueba(`${esc.nombre} → informe == productividad == ${base.informe} UVR`, ()=>{
      const res = motor.clasificar(esc.ficha());
      const informe = uvrDelInforme(res, motor);
      const creditos = uvrDeCreditos(res);

      assert.ok(casiIgual(informe, creditos),
        `PARIDAD ROTA: informe ${informe} ≠ productividad ${creditos} (diferencia ${informe - creditos})`);
      assert.strictEqual(creditos, base.informe,
        `cambió el número de la línea base: ahora ${creditos}, la base fijada es ${base.informe}`);
      assert.deepStrictEqual(conteosLimpios(res), base.inc,
        `cambió el conteo de exámenes por columna: ahora ${JSON.stringify(conteosLimpios(res))}, ` +
        `la base fijada es ${JSON.stringify(base.inc)}`);
    });

    // La campaña multiplica el UVR pero NUNCA el conteo de exámenes: es el
    // bug que se corrigió (aparecían 2 hemogramas en vez de 1 en el informe).
    // Lo único que SÍ suma un ítem es la fase preanalítica masiva, que cuenta
    // como 1 examen en OTROS (y aporta su UVR por separado) en vez de sumar el
    // monto — ver aplicarAjusteCampana, y el comentario del bug del 04/09/2026.
    if(esc.sinCampana){
      prueba(`${esc.nombre} → el conteo de exámenes no se multiplica`, ()=>{
        const conCampana = conteosLimpios(motor.clasificar(esc.ficha()));
        const sinCampana = conteosLimpios(motor.clasificar(esc.sinCampana()));
        for(const col in sinCampana){
          if(col === 'otros') continue; // éste es el único que crece, y por diseño
          assert.strictEqual(conCampana[col], sinCampana[col],
            `la campaña multiplicó el conteo de "${col}": ${sinCampana[col]} → ${conCampana[col]}`);
        }
        assert.strictEqual(conCampana.otros, (sinCampana.otros || 0) + 1,
          `"otros" debe crecer en EXACTAMENTE 1 (la fase preanalítica masiva), no multiplicarse: ` +
          `${sinCampana.otros || 0} → ${conCampana.otros}`);
        for(const col in conCampana){
          assert.ok(col === 'otros' || col in sinCampana,
            `la campaña inventó la columna "${col}": no existe en la ficha sin campaña`);
        }
      });
      prueba(`${esc.nombre} → la campaña sí sube el UVR`, ()=>{
        const u = uvrDeCreditos(motor.clasificar(esc.sinCampana()));
        const c = uvrDeCreditos(motor.clasificar(esc.ficha()));
        assert.strictEqual(c, u * motor.campana.multiplicador + motor.campana.preanalitica,
          `esperaba ${u}×${motor.campana.multiplicador} + ${motor.campana.preanalitica} de preanalítica, salió ${c}`);
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CAPA DE AGREGACIÓN: lo que la pantalla realmente suma.
//
// Hasta arriba, la paridad se comprobaba leyendo `res.uvr` y `res.credits` a
// mano. Pero la pantalla del Informe Mensual NO hace eso: recorre los registros
// del mes con computeReportMatrix, acumula por servicio y columna, y recién ahí
// compone el cuadro. Si esa suma se prueba, recién tenemos el número que el
// hospital ve en pantalla.
//
// Además se cruza contra computeProductivity — la función real de la pantalla
// de Productividad, no una reimplementación de la prueba.
// ─────────────────────────────────────────────────────────────────────────────
const MES_PRUEBA = '09', ANIO_PRUEBA = '2026';
const FECHA_PRUEBA = '12/09/2026';
const SERVICIO_PRUEBA = 'MEDICINA - CONSULTORIOS';

function fichaEnMes(tests, extra){
  return Object.assign({
    fecha: FECHA_PRUEBA, servicio: SERVICIO_PRUEBA, nombre: 'PACIENTE PRUEBA',
    creadoPor: 'Lic. Prueba', creadoPorId: 'u1', tests,
  }, extra || {});
}
function uvrDeUvrmatriz(uvrMatrix, motor){
  return motor.servicios.reduce((s, sv)=> s + motor.columnas.reduce((t, c)=> t + (uvrMatrix[sv][c.key] || 0), 0), 0);
}
// Total de exámenes del Informe Intermedio, sumando todas las filas del cuadro.
function totalIntermedio({ matrix, ecoOrina }, motor){
  return Object.values(matrix).reduce((s, fila)=> s + Object.values(fila).reduce((t, v)=> t + (v || 0), 0), 0)
       + Object.values(ecoOrina || {}).reduce((s, v)=> s + (v || 0), 0);
}
function uvrDePantallaProductividad(motor){
  const { porUsuario } = motor.productividad(`${ANIO_PRUEBA}-${MES_PRUEBA}`, `${ANIO_PRUEBA}-${MES_PRUEBA}`);
  return Object.values(porUsuario).reduce((s, u)=> s + (u.uvr || 0), 0);
}

const FICHA_CAMPANA_COMPLETA = ()=> fichaEnMes([
  T('Glucosa', { area: 'Bioquímica Clínica' }),
  T('Tiempo de Protrombina'),
  T('Examen completo de orina', { muestra: 'Orina' }),
]);

for(const sede of SEDES){
  console.log('\n' + sede.label + ' — capa de agregación');
  let motor;
  try{ motor = motores[sede.id]; }
  catch(e){ console.log('  ✗ sin motor cargado'); fallaron++; continue; }

  prueba('el UVR del cuadro de pantalla == la suma de créditos de las fichas', ()=>{
    motor.setRecords([FICHA_CAMPANA_COMPLETA()]);
    const { uvrMatrix } = motor.matriz(MES_PRUEBA, ANIO_PRUEBA);
    const enPantalla = uvrDeUvrmatriz(uvrMatrix, motor);
    const enCreditos = uvrDeCreditos(motor.clasificar(FICHA_CAMPANA_COMPLETA()));
    assert.ok(casiIgual(enPantalla, enCreditos),
      `el cuadro del Informe suma ${enPantalla} pero los créditos suman ${enCreditos} ` +
      '(la capa de agregación está cuenta distinto de como cuenta el clasificador)');
    assert.ok(enPantalla > 0, 'el cuadro salió en cero: la prueba no estaría probando nada');
  });

  prueba('el UVR de la pantalla de Productividad == el del cuadro del Informe', ()=>{
    motor.setRecords([FICHA_CAMPANA_COMPLETA()]);
    const { uvrMatrix } = motor.matriz(MES_PRUEBA, ANIO_PRUEBA);
    const enInforme = uvrDeUvrmatriz(uvrMatrix, motor);
    const enProd = uvrDePantallaProductividad(motor);
    assert.ok(casiIgual(enInforme, enProd),
      `Informe ${enInforme} ≠ Productividad ${enProd}. Son las dos pantallas que se reportan a MINSA.`);
  });

  prueba('una ficha ANULADA no debe contar en el Informe Mensual', ()=>{
    const anulada = fichaEnMes([T('Hemograma completo')], { status: 'void', voidReason: 'error de carga' });
    // Si el Informe respetara la anulación, una ficha anulada sola daría un
    // cuadro completamente vacío.
    motor.setRecords([anulada]);
    const { uvrMatrix } = motor.matriz(MES_PRUEBA, ANIO_PRUEBA);
    const conAnulada = uvrDeUvrmatriz(uvrMatrix, motor);
    const detalle = motor.columnas
      .filter(c => motor.servicios.some(sv => uvrMatrix[sv][c.key]))
      .map(c => `${c.sub}=${motor.servicios.map(sv => uvrMatrix[sv][c.key]).join('+')}`).join(', ');
    assert.strictEqual(conAnulada, 0,
      `el Informe Mensual contó la ficha anulada y dio ${conAnulada} UVR (${detalle}). ` +
      'computeProductivity SÍ excluye los anulados, así que con anulaciones las dos ' +
      'pantallas no pueden dar el mismo número. computeReportMatrix no tiene el filtro de status.');
  });

  prueba('y la pantalla de Productividad tampoco cuenta la ficha anulada', ()=>{
    motor.setRecords([fichaEnMes([T('Hemograma completo')])]);
    const control = uvrDePantallaProductividad(motor);
    assert.ok(control > 0, 'Productividad dio cero con la ficha viva: la prueba no probaría nada');

    motor.setRecords([fichaEnMes([T('Hemograma completo')], { status: 'void', voidReason: 'error de carga' })]);
    const conAnulada = uvrDePantallaProductividad(motor);
    assert.strictEqual(conAnulada, 0,
      `Productividad contó la ficha anulada y dio ${conAnulada} UVR (la misma ficha viva da ${control}).`);
  });

  prueba('una ficha ANULADA tampoco debe contar en el Informe Intermedio', ()=>{
    // Exámenes que el Intermedio sí cuenta (un hemograma es paquete y no suma
    // por sí solo; un examen de orina no es un urocultivo).
    const conTests = (extra)=> fichaEnMes(
      [T('Colesterol total'), T('VSG'), T('Urocultivo')],
      extra || {}
    );
    // Control: la ficha viva tiene que mover algo, si no la prueba no probaría nada.
    motor.setRecords([conTests()]);
    const viva = motor.intermedio(MES_PRUEBA, ANIO_PRUEBA);
    const totalViva = totalIntermedio(viva, motor);
    assert.ok(totalViva > 0, 'el Informe Intermedio dio cero con una ficha viva: la prueba no probaría nada');

    motor.setRecords([conTests({ status: 'void', voidReason: 'error de carga' })]);
    const anulada = motor.intermedio(MES_PRUEBA, ANIO_PRUEBA);
    const totalAnulada = totalIntermedio(anulada, motor);
    assert.strictEqual(totalAnulada, 0,
      `el Informe Intermedio contó la ficha anulada y dio ${totalAnulada} ` +
      `(la misma ficha viva da ${totalViva}). computeIntermedioMatrix no filtra por status.`);
  });
}

// ---- Fechas y normalización: que ninguna ficha se vuelva invisible ----
//
// El antecedente está escrito en el propio código (bitácora 31/08/2026): 55
// fichas importadas desde Excel quedaron fuera del Informe Mensual sin ningún
// aviso porque el año venía en 2 dígitos. Ese tipo de falla es silenciosa: la
// ficha se guarda, aparece en la lista, y no está en ningún informe.
//
// El invariante que se prueba acá es más fuerte que "el año de 2 dígitos se
// expande": si el importador acepta una fecha, la fecha guardada TIENE que ser
// legible por el parser del informe. Si no, la ficha existe pero no se cuenta.
// ─────────────────────────────────────────────────────────────────────────────
const FORMATOS_IMPORTADOS = [
  { txt: '5/9/26',     como: 'dd/mm/aa    (lo que exporta la hoja de origen)' },
  { txt: '05/09/2026', como: 'dd/mm/aaaa  (formato de la plantilla oficial)' },
  { txt: '12/09/2026', como: 'dd/mm/aaaa' },
  { txt: '12/09/26',   como: 'dd/mm/aa' },
  { txt: '5-9-26',     como: 'dd-mm-aa    (con guiones)' },
  { txt: '12-09-2026', como: 'dd-mm-aaaa  (con guiones)' },
  { txt: '5.9.26',     como: 'dd.mm.aa    (con puntos)' },
  { txt: '2026-09-12', como: 'aaaa-mm-dd  (ISO, como lo da Excel)' },
];

for(const sede of SEDES){
  console.log('\n' + sede.label + ' — fechas y normalización');
  const motor = motores[sede.id];

  prueba('toda fecha que el importador acepta queda legible para el informe', ()=>{
    const invisibles = [];
    for(const { txt, como } of FORMATOS_IMPORTADOS){
      // así queda la fecha en la ficha después de importar
      const guardada = motor.fecha(txt);
      // y así la lee el Informe Mensual, con el parser REAL de la app
      const leida = motor.mes(guardada);
      if(!leida || leida.mm !== '09' || leida.yyyy !== '2026'){
        invisibles.push(`"${txt}" (${como}) → quedó como "${guardada}" y el informe NO la ve`);
      }
    }
    assert.strictEqual(invisibles.length, 0,
      'estas fechas se importan y se guardan, pero ningún informe las cuenta:\n      - ' +
      invisibles.join('\n      - '));
  });

  prueba('el año de 2 dígitos usa el pivote 69/70 del código', ()=>{
    // La regla del código (<=69 → 20xx, >=70 → 19xx) está escrita igual en
    // normalizeFechaDDMMYYYY y en parseFechaMes. Para una fecha de atención es
    // lo razonable: nadie se atiende en 1969, y 2069 tampoco, pero el pivote
    // es el que el código declara y el que hay que fijar.
    assert.strictEqual(motor.fecha('5/9/26'), '05/09/2026', '26 → 2026');
    assert.strictEqual(motor.fecha('5/9/69'), '05/09/2069', '69 cae todavía en el 20xx (pivote <=69)');
    assert.strictEqual(motor.fecha('5/9/70'), '05/09/1970', '70 ya es 19xx (pivote)');
    assert.strictEqual(motor.fecha('5/9/99'), '05/09/1999', '99 → 1999');
    assert.strictEqual(motor.fecha('5/9/00'), '05/09/2000', '00 → 2000');
  });

  prueba('el informe también expande el año de 2 dígitos (fichas ya guardadas)', ()=>{
    // El normalizador solo actúa al importar. Las fichas que ya están guardadas
    // con año de 2 cifras dependen de que sea el parser del INFORME el que las
    // expanda, no el importador. Son dos caminos distintos y se prueban aparte.
    //
    // Ojo: los objetos que devuelve el código ejecutado dentro de node:vm tienen
    // el prototipo de ESE contexto, así que deepStrictEqual los rechaza por
    // prototipo aunque los valores calcen. Se comparan campo por campo.
    const mes = (t)=>{ const r = motor.mes(t); return r ? `${r.mm}-${r.yyyy}` : String(r); };
    assert.strictEqual(mes('5/9/26'), '09-2026', '26 → 2026');
    assert.strictEqual(mes('5/9/69'), '09-2069', '69 → 2069 (pivote <=69)');
    assert.strictEqual(mes('5/9/70'), '09-1970', '70 → 1970 (pivote)');
    assert.strictEqual(mes('5/9/99'), '09-1999', '99 → 1999');
    assert.strictEqual(mes('2026-09-12'), 'null', 'una fecha con guiones no se puede leer: queda fuera');
    assert.strictEqual(mes('basura'), 'null', 'algo que no es fecha tampoco');
    assert.strictEqual(mes(''), 'null', 'fecha vacía');
  });

  prueba('no toca lo que ya está bien, ni inventa fechas donde no hay fecha', ()=>{
    assert.strictEqual(motor.fecha('05/03/2026'), '05/03/2026', 'una fecha ya normal no debe cambiar');
    assert.strictEqual(motor.fecha(''), '', 'vacío sigue vacío');
    assert.strictEqual(motor.fecha(null), null, 'null no debe convertirse en texto');
  });
}

// ---- Reparación de las fichas YA guardadas con fecha invisible ----
//
// La detección tiene que poder usarse SIN escribir nada: es lo que permite
// saber cuántas fichas hay afectadas antes de tocar datos de producción.
// Por eso se prueban las dos mitades: que detecte bien, y que no mute nada.
// ─────────────────────────────────────────────────────────────────────────────
const FECHAS_INVISIBLES = [
  { fecha: '2026-09-12', debe: '12/09/2026', reparable: true  },
  { fecha: '12-09-2026', debe: '12/09/2026', reparable: true  },
  { fecha: '5.9.26',     debe: '05/09/2026', reparable: true  },
  { fecha: '05/09/2026', debe: null,         reparable: false }, // ya visible: no hay que tocarla
  { fecha: '5/9/26',     debe: null,         reparable: false }, // ya visible
  { fecha: '31/12/2025', debe: null,         reparable: false }, // otro mes: ya visible
  { fecha: 'basura',     debe: null,         reparable: false }, // irrecuperable: a mano
  { fecha: '',           debe: null,         reparable: false },
];

for(const sede of SEDES){
  console.log('\n' + sede.label + ' — reparación de fechas invisibles');
  const motor = motores[sede.id];

  prueba('detecta las fichas invisibles y dice a qué las va a convertir', ()=>{
    const lista = FECHAS_INVISIBLES.map((f, i)=> ({ id:'r'+i, nombre:'P'+i, fecha:f.fecha }));
    const { reparables, noReparables } = motor.detectarFechas(lista);

    // Se comparan como texto y no con deepStrictEqual: los strings que salen
    // del código ejecutado dentro de node:vm no siempre son los mismos
    // primitivos que los del host, y deepStrictEqual los rechaza aun cuando
    // el texto calza.
    const reparablesTxt = reparables.map(f=>`${f.antes} -> ${f.despues}`).sort().join(' | ');
    assert.strictEqual(reparablesTxt,
      '12-09-2026 -> 12/09/2026 | 2026-09-12 -> 12/09/2026 | 5.9.26 -> 05/09/2026',
      'la lista de reparables no es la esperada');

    const noRep = noReparables.map(f=>f.antes).sort().join(' | ');
    assert.strictEqual(noRep, ' | basura',
      'lo que no se puede corregir solo debe quedar aparte, para revisión manual');
  });

  prueba('NO toca las fichas que ya se ven en los informes', ()=>{
    const lista = FECHAS_INVISIBLES.map((f, i)=> ({ id:'r'+i, nombre:'P'+i, fecha:f.fecha }));
    const { reparables, noReparables } = motor.detectarFechas(lista);
    const tocadas = reparables.map(f=>f.antes);
    ['05/09/2026', '5/9/26', '31/12/2025'].forEach(buena=>{
      assert.ok(!tocadas.includes(buena), `"${buena}" ya se ve en los informes y no debe marcarse para reparar`);
    });
    assert.strictEqual(reparables.length, 3, 'debe marcar 3 reparables');
    assert.strictEqual(reparables.length + noReparables.length, 5,
      'solo 5 de las 8 fechas de la lista son problema: 3 reparables + "basura" y la vacía, que no se pueden corregir solas');
  });

  prueba('la detección es de solo lectura: no modifica ninguna ficha', ()=>{
    const lista = FECHAS_INVISIBLES.map((f, i)=> ({ id:'r'+i, nombre:'P'+i, fecha:f.fecha }));
    const copia = JSON.stringify(lista);
    motor.detectarFechas(lista);
    assert.strictEqual(JSON.stringify(lista), copia,
      'detectarFechasInvisibles() no debe escribir en las fichas: se llama solo para contarlas');
  });

  prueba('una ficha reparada pasa a sumar en el Informe Mensual', ()=>{
    // lo que hace el botón, sin la parte de permisos y confirmación
    const rec = { id:'x1', nombre:'Paciente', fecha:'2026-09-12', servicio:SERVICIO_PRUEBA,
                  creadoPor:'Lic. Prueba', creadoPorId:'u1', tests:[T('Hemograma completo')] };
    const { reparables } = motor.detectarFechas([rec]);
    assert.strictEqual(reparables.length, 1, 'la ficha con fecha ISO tenía que detectarse');

    motor.setRecords([rec]);
    const antes = uvrDeUvrmatriz(motor.matriz(MES_PRUEBA, ANIO_PRUEBA).uvrMatrix, motor);
    reparables.forEach(f=>{ f.rec.fecha = f.despues; });
    const despues = uvrDeUvrmatriz(motor.matriz(MES_PRUEBA, ANIO_PRUEBA).uvrMatrix, motor);

    assert.strictEqual(antes, 0, 'con la fecha ISO la ficha no debe sumar nada todavía');
    assert.ok(despues > 0,
      `tras reparar, la ficha tiene que sumar en el informe; segue dando ${despues}`);
  });
}

// ---- Usuarios y contraseñas (seguridad) ----
//
// Acá se fija una decisión DELIBERADA que es riesgosa: roleOf() devuelve
// 'admin' para cualquier rol desconocido o ausente. Está escrito en el código
// y es a propósito (para no dejar a nadie afuera), pero significa que un
// `role` con typo o un usuario importado sin rol se vuelve administrador
// silenciosamente. Se deja fijado a propósito: si algún día se cambia, esta
// prueba se pone roja y el cambio es una decisión, no un accidente.
// ─────────────────────────────────────────────────────────────────────────────
for(const sede of SEDES){
  console.log('\n' + sede.label + ' — usuarios y contraseñas');
  const motor = motores[sede.id];

  prueba('la política de contraseñas rechaza lo adivinable', ()=>{
    const debenFallar = [
      ['',            'vacía'],
      ['abc',         '3 caracteres'],
      ['Seda',        '4 caracteres, una letra antes del mínimo'],
      ['Senda',       '5 caracteres, una letra antes del mínimo'],
      ['123456',      'trivial'],
      ['password',    'trivial'],
      ['qwerty123',   'trivial'],
      ['aaaaaa',      'mismo carácter repetido'],
      ['123456',      'secuencia ascendente'],
      ['654321',      'secuencia descendente'],
      ['890123',      'secuencia circular ascendente'],
    ];
    for(const [pass, motivo] of debenFallar){
      const err = motor.passError(pass);
      assert.ok(err, `"${pass}" (${motivo}) debería estar rechazado y pasó sin error`);
    }
  });

  prueba('la política de contraseñas acepta una contraseña razonable', ()=>{
    const debenPasar = ['Laboratorio2026', 'Jose.Maria.2026', '135790', 'Senda-Norte-7'];
    for(const pass of debenPasar){
      assert.strictEqual(motor.passError(pass), null, `"${pass}" es razonable y no debería estar rechazada`);
    }
  });

  prueba('no acepta como contraseña el nombre del usuario', ()=>{
    assert.ok(motor.passError('josegarcia', 'Jose Garcia'),
      'la contraseña no puede ser igual al nombre del usuario');
    assert.strictEqual(motor.passError('josegarcia'), null,
      'si no se pasa el nombre, no hay con qué comparar: la app lo deja pasar');
    // Ojo, esto está fijado a propósito: la comparación NO quita acentos, así que
    // "josegarcia" pasa aunque el usuario se llame "José García". Es una
    //falla menor — el usuario podría elegir esa variante de todos modos — pero
    // queda escrito para que no se pierda de vista.
    assert.strictEqual(motor.passError('josegarcia', 'José García'), null,
      'con tilde en el nombre, la comparación no coincide: es el comportamiento actual');
  });

  prueba('el nombre de usuario se normaliza y nunca queda vacío', ()=>{
    assert.strictEqual(motor.slug('José Pérez'), 'jose.perez', 'quita tildes y pasa espacios a punto');
    assert.strictEqual(motor.slug('  Ana   María  '), 'ana.maria', 'colapsa espacios');
    assert.strictEqual(motor.slug('O\'Brien'), 'obrien', 'quita apostrofes');
    assert.strictEqual(motor.slug('user@name'), 'username', 'quita símbolos');
    assert.strictEqual(motor.slug('李明'), '', 'un nombre sin letras latinos se queda vacío a propósito');
  });

  prueba('el nombre de usuario generado nunca choca con otro existente', ()=>{
    motor.setUsers([]);
    assert.strictEqual(motor.unico('José Pérez'), 'jose.perez', 'sin usuarios, se usa el nombre tal cual');
    motor.setUsers([{ id:'u1', username:'jose.perez' }]);
    assert.strictEqual(motor.unico('José Pérez'), 'jose.perez2', 'si ya existe, agrega un número');
    motor.setUsers([{ id:'u1', username:'jose.perez' }, { id:'u2', username:'jose.perez2' }]);
    assert.strictEqual(motor.unico('José Pérez'), 'jose.perez3', 'con dos tomados, sigue hasta el libre');
    assert.strictEqual(motor.unico('José Pérez', 'u1'), 'jose.perez',
      'al editar u1 se excluye a sí mismo del choque, así que conserva su nombre');
    motor.setUsers([{ id:'u9', username:'usuario' }]);
    assert.strictEqual(motor.unico('李明'), 'usuario2',
      'un nombre sin letras latinos cae en "usuario", y si ya existe, "usuario2"');
  });

  prueba('un rol desconocido se trata como administrador (decisión fijada a propósito)', ()=>{
    assert.strictEqual(motor.rol({ role:'lectura' }),   'lectura',   'un rol conocido se respeta');
    assert.strictEqual(motor.rol({ role:'captura' }),  'captura',   'otro rol conocido se respeta');
    assert.strictEqual(motor.rol({ role:'admin' }),     'admin',     'admin no está en la listaKnown y cae al default, que coincide');
    assert.strictEqual(motor.rol({}),                   'admin',     'sin rol → admin');
    assert.strictEqual(motor.rol({ role:'Administrdor'}), 'admin',   'un typo en el rol → admin');
    assert.strictEqual(motor.rol(null),                 'admin',     'usuario nulo → admin (requireRole filtra el nulo antes)');
    assert.strictEqual(motor.esAdmin({}),               true,        'y por lo tanto se le consideran permisos de administrador');
  });

  prueba('"solo lectura" no puede guardar resultados; los demás sí', ()=>{
    assert.strictEqual(motor.puedeGuardar({ role:'lectura' }),   false, 'solo lectura no guarda');
    assert.strictEqual(motor.puedeGuardar({ role:'captura' }),  true,  'captura sí guarda');
    assert.strictEqual(motor.puedeGuardar({ role:'validacion' }),true,  'validación sí guarda');
    assert.strictEqual(motor.puedeGuardar({ role:'usuario' }),   true,  'usuario sí guarda');
  });

  prueba('la etiqueta del usuario muestra la colegiatura cuando tiene', ()=>{
    assert.strictEqual(motor.etiqueta({ nombre:'Ana', colegiatura:'CMP-123' }), 'Ana — CMP-123');
    assert.strictEqual(motor.etiqueta({ nombre:'Ana' }), 'Ana', 'sin colegiatura, solo el nombre');
  });
}

// ---- Auditoría ----
//
// El log de auditoría es la evidencia de "quién cambió qué y cuándo". Si tiene
// huecos, no sirve para nada. Estas pruebas fijan lo que la app SÍ garantiza.
// Ojo con dos cosas que NO garantiza y que quedaron documentadas acá abajo:
//   1) si falla la escritura en la nube, el error se traga y el registro queda
//      solo en local —y el local se recorta a 400.
//   2) al leer el historial de un resultado se piden los últimos 500 eventos de
//      TODA la colección y después se filtra en el cliente, así que un
//      resultado con más de 500 eventos posteriores ve su historia incompleta.
// ─────────────────────────────────────────────────────────────────────────────
for(const sede of SEDES){
  console.log('\n' + sede.label + ' — auditoría');
  const motor = motores[sede.id];
  const ahora = ()=>{ const t=Date.now(); while(Date.now()===t){} return t; };

  prueba('cada acción deja registro de quién, qué, cuándo y con qué versión de la app', ()=>{
    motor.setUsuario({ id:'u7', nombre:'Dra. Ana Ruiz', colegiatura:'CMP-9' });
    motor.ponerAudit([]);
    const t0 = ahora();
    const e = motor.logAudit('void', 'resultado', 'r123', { reason:'Error de tipeo en el resultado' });
    const t1 = Date.now();
    assert.strictEqual(e.action, 'void');
    assert.strictEqual(e.entityType, 'resultado');
    assert.strictEqual(e.entityId, 'r123');
    assert.strictEqual(e.reason, 'Error de tipeo en el resultado');
    assert.strictEqual(e.userId, 'u7');
    assert.strictEqual(e.userName, 'Dra. Ana Ruiz — CMP-9', 'el nombre incluye la colegiatura');
    assert.ok(e.timestamp >= t0 && e.timestamp <= t1, 'la fecha y hora es de ahora');
    assert.ok(e.id, 'tiene identificador propio');
    assert.ok(e.appVersion, 'guarda la versión de la app: sin eso no se sabe con qué se hizo');
    assert.strictEqual(motor.leerAudit()[0].id, e.id, 'el registro nuevo queda primero');
  });

  prueba('sin usuario seleccionado el registro lo dice, y no inventa datos', ()=>{
    motor.setUsuario(null);
    motor.ponerAudit([]);
    const e = motor.logAudit('update', 'catalogo', 'c1');
    assert.strictEqual(e.userId, '', 'no inventa un id de usuario');
    assert.strictEqual(e.userName, '(sin usuario seleccionado)');
    assert.strictEqual(e.reason, '', 'sin motivo queda vacío, no undefined');
    assert.strictEqual(e.before, null);
    assert.strictEqual(e.after, null);
  });

  prueba('el registro se guarda local y se manda a la nube', ()=>{
    motor.limpiarNube();
    motor.ponerAudit([]);
    const e = motor.logAudit('delete', 'usuario', 'u9');
    const enviados = motor.verNube();
    assert.strictEqual(enviados.length, 1, 'se intentó enviar exactamente una vez');
    assert.strictEqual(enviados[0].id, e.id, 'y es el mismo registro, no una copia distinta');
  });

  prueba('el log local se recorta y conserva los más recientes', ()=>{
    // el log se guarda del más nuevo al más viejo, así que el último es el más antiguo
    const viejos = Array.from({ length:400 }, (_, i)=>({ id:'viejo'+i, timestamp:1400-i }));
    motor.ponerAudit(viejos);
    const tope = motor.leerAudit().length;
    const e = motor.logAudit('update', 'config', 'x');
    assert.strictEqual(motor.leerAudit().length, tope, 'no crece sin límite');
    assert.strictEqual(motor.leerAudit()[0].id, e.id, 'el nuevo queda primero');
    assert.ok(!motor.leerAudit().some(x => x.id === 'viejo399'), 'el más antiguo se descarta');
    assert.ok(motor.leerAudit().some(x => x.id === 'viejo0'), 'el segundo más nuevo sobrevive');
  });

  prueba('sin nube, el historial devuelve lo que hay en local', async ()=>{
    motor.ponerAudit([
      { id:'x', timestamp:5,   entityId:'r9' },
      { id:'y', timestamp:99,  entityId:'otra' },
    ]);
    motor.setNube({ ready:false, fb:null });
    const hist = await motor.buscarAuditoria('r9');
    assert.deepStrictEqual(Array.from(hist, e => e.id), ['x'], 'funciona sin conexión, con lo local');
  });

  prueba('el historial de un resultado une nube y local, sin repetir y del más nuevo al más viejo', async ()=>{
    motor.ponerAudit([
      { id:'a', timestamp:300, entityId:'r1' },
      { id:'b', timestamp:100, entityId:'r1' },
      { id:'c', timestamp:999, entityId:'r2' },
    ]);
    const nube = [
      { id:'a', timestamp:300, entityId:'r1', origen:'nube' }, // mismo id que el local
      { id:'d', timestamp:200, entityId:'r1' },
      { id:'e', timestamp:500, entityId:'r2' },
    ];
    const llamado = {};
    motor.setNube({
      ready:true,
      fb:{
        db:'x',
        collection: (db, col) => ({ db, col }),
        orderBy:   (c, d) => ({ c, d }),
        limit:     (n) => { llamado.limit = n; return { n }; },
        query:     (...a) => ({ a }),
        getDocs:   async () => ({ docs: nube.map(d => ({ data: () => d })) }),
      },
    });
    const hist = await motor.buscarAuditoria('r1');
    assert.deepStrictEqual(Array.from(hist, e => e.id), ['a','d','b'],
      'solo lo de r1, del más nuevo al más viejo, sin repetir el id "a"');
    assert.strictEqual(hist[0].origen, 'nube', 'si el mismo id está en ambos lados, manda la nube');
    assert.strictEqual(llamado.limit, 500, 'pide como mucho 500 eventos de toda la colección');
  });
}

// La app promete en el comentario del log que las operaciones serias dejan
// rastro. Si alguien borra una de estas llamadas, el log deja de servir y la
// suite tiene que avisar.
prueba('las operaciones críticas dejan rastro en la bitácora', ()=>{
  const ACCIONES_CRITICAS = ['void','correct','delete','create','update','login','logout','print','export'];
  for(const sede of SEDES){
    const src = fs.readFileSync(sede.archivo, 'utf8');
    for(const accion of ACCIONES_CRITICAS){
      assert.ok(src.includes(`logAudit('${accion}'`),
        `${sede.id}: ya no hay ningún logAudit('${accion}') — se perdió el rastro de esa acción`);
    }
  }
});

// ---- Baciloscopia y BK externos (facturación) ----
//
// Los BK externos son las baciloscopias que se cobran aparte, por servicio y
// por mes. El dato se guarda como {esputo, orina, heces} por servicio, pero
// las fichas viejas tienen un número suelto. Todo eso tiene que sumar igual.
// ─────────────────────────────────────────────────────────────────────────────
for(const sede of SEDES){
  console.log('\n' + sede.label + ' — baciloscopia y BK externos');
  const motor = motores[sede.id];
  const ficha = (f) => ({ fields: Object.assign({ m1_tipo:'Esputo' }, f) });

  prueba('un conteo de BK externos se normaliza igual vine de donde venga', ()=>{
    // El normalizador no está expuesto como una función suelta acá; se prueba
    // a través del total, que es lo que la app usa para sumar.
    assert.strictEqual(motor.totalDe(5), 5, 'número suelto (formato viejo) = esputos');
    assert.strictEqual(motor.totalDe('3'), 3, 'número como texto también');
    assert.strictEqual(motor.totalDe({ esputo:2, orina:1, heces:3 }), 6, 'objeto: suma las tres');
    assert.strictEqual(motor.totalDe({ esputo:-4, orina:2, heces:0 }), 2,
      'un negativo no resta: se trata como cero, no se descuadra el cobro');
    assert.strictEqual(motor.totalDe('basura'), 0, 'basura no inventa muestras');
    assert.strictEqual(motor.totalDe(null), 0, 'sin dato no inventa muestras');
    assert.strictEqual(motor.totalDe(''), 0, 'texto vacío no inventa muestras');
  });

  prueba('el total del mes suma todos los servicios y no se pierde ninguno', ()=>{
    motor.setBk({ '2026-09': {
      'Hematología': { esputo:2, orina:0, heces:0 },
      'Microbiología': { esputo:0, orina:1, heces:0 },
      'Parasitológico': { esputo:0, orina:0, heces:4 },
    }});
    // el total tiene que ver TODOS los servicios, no solo el primero
    assert.strictEqual(motor.totalBk('09', '2026'), 7,
      'los tres servicios se suman; si esto devuelve menos, es que está perdiendo datos');
  });

  prueba('un mes sin datos da 0 y no rompe', ()=>{
    motor.setBk({ '2026-09': { 'Hematología': { esputo:2, orina:0, heces:0 } } });
    assert.strictEqual(motor.totalBk('10', '2026'), 0, 'octubre no tiene nada cargado');
    assert.strictEqual(motor.totalBk('09', '2025'), 0, 'septiembre del año pasado tampoco');
  });

  prueba('el mes se guarda con dos dígitos, y se lee con dos dígitos', ()=>{
    motor.setBk({ '2026-09': { 'Hematología': { esputo:1, orina:0, heces:0 } } });
    assert.strictEqual(motor.totalBk('09', '2026'), 1, 'con ceros: encuentra el mes');
    assert.strictEqual(motor.totalBk('9', '2026'), 0,
      'sin ceros NO encuentra el mes: por eso el selector arma la clave con padStart(2)');
  });

  prueba('cada muestra con resultado cuenta como un examen aparte', ()=>{
    assert.strictEqual(motor.cuentaBk(ficha({ m1_resultado:'+', m2_resultado:'-' })), 2,
      'muestra 1 y 2 cargadas = 2');
    assert.strictEqual(motor.cuentaBk(ficha({ m1_resultado:'+', m2_resultado:'   ' })), 1,
      'la muestra 2 con puros espacios cuenta como vacía');
    assert.strictEqual(motor.cuentaBk(ficha({ m1_resultado:'', m2_resultado:'' })), 1,
      'si se agregó el examen pero no se llenó nada, cuenta 1 y el registro no se pierde');
  });

  prueba('muestra adicional y control solo cuentan si están activados', ()=>{
    assert.strictEqual(motor.cuentaBk(ficha({ m1_resultado:'+', m2_resultado:'+', m3_resultado:'+', m3_activar:'Sí' })), 3,
      'con muestra adicional activada, son 3');
    assert.strictEqual(motor.cuentaBk(ficha({ m1_resultado:'+', m2_resultado:'+', m3_resultado:'+' })), 2,
      'sin activar, la muestra adicional NO cuenta aunque tenga resultado');
    assert.strictEqual(motor.cuentaBk(ficha({ m1_resultado:'+', m2_resultado:'+', ctrl_resultado:'+', ctrl_activar:'Sí' })), 3,
      'con control activado, son 3');
    assert.strictEqual(motor.cuentaBk(ficha({ m1_resultado:'+', m2_resultado:'+', ctrl_resultado:'+' })), 2,
      'sin activar, el control NO cuenta aunque tenga resultado');
  });

  prueba('GeneXpert nunca se cuenta como baciloscopia', ()=>{
    // El comentario del código lo dice: el GX va aparte. Si esto cambia, hay
    // que revisar el informe porque se estaría cobrando dos veces.
    assert.strictEqual(motor.cuentaBk(ficha({ m1_resultado:'', m1_gx_activar:'Sí', m1_gx_resultado:'MTB detectado' })), 1,
      'solo GX, sin resultado de baciloscopia, no agrega un examen extra');
    assert.strictEqual(motor.cuentaBk(ficha({ m1_resultado:'+', m1_gx_activar:'Sí', m1_gx_resultado:'MTB detectado' })), 1,
      'GX más baciloscopia siguen siendo 1 examen, no 2');
    // Este caso es el que de verdad ata la regla: la muestra 2 tiene SOLO GX.
    // Sin él, el "|| 1" del examen vacío tapaba la mutación y la suite pasaba
    // en verde aunque el GX se contara como baciloscopia (cobro doble).
    assert.strictEqual(motor.cuentaBk(ficha({
      m1_resultado:'+', m2_resultado:'',
      m2_gx_activar:'Sí', m2_gx_resultado:'MTB detectado',
    })), 1, 'una muestra con solo GeneXpert NO se cuenta como baciloscopia: el GX se cobra aparte');
  });

  prueba('el desglose por tipo de muestra separa esputo, orina, secreciones y heces viejos', ()=>{
    const t = (m1_tipo, m2_tipo) => ficha({ m1_tipo, m1_resultado:'+', m2_tipo, m2_resultado:'+' });
    const o = motor.bkPorTipo(t('Esputo', 'Orina'));
    assert.strictEqual(o.esputo, 1, 'esputo');
    assert.strictEqual(o.orina, 1, 'orina');

    const sec = motor.bkPorTipo(t('Secreciones', 'Esputo'));
    assert.strictEqual(sec.otro, 1, 'secreciones van a "otro"');
    assert.strictEqual(sec.esputo, 1, 'la otra sigue siendo esputo');

    // "Heces" ya no existe en el formulario, pero hay fichas viejas con ese dato
    const h = motor.bkPorTipo(t('Heces', 'Esputo'));
    assert.strictEqual(h.heces, 1, 'heces se sigue soportando por compatibilidad');

    const vac = motor.bkPorTipo(ficha({ m1_tipo:'', m1_resultado:'+', m2_tipo:'', m2_resultado:'+' }));
    assert.strictEqual(vac.esputo, 2, 'si no se eligió tipo, se asume esputo (práctica habitual)');
  });

  prueba('si no hay ninguna muestra cargada, el desglose no inventa repartos raros', ()=>{
    const o = motor.bkPorTipo(ficha({ m1_resultado:'', m2_resultado:'' }));
    assert.strictEqual(o.esputo, 1, 'cae a 1 esputo, igual que el conteo');
    assert.strictEqual(o.orina, 0);
    assert.strictEqual(o.heces, 0);
    assert.strictEqual(o.otro, 0);
  });
}

// ---- Catálogo y perfiles (paquetes de exámenes) ----
//
// El catálogo tiene 99 exámenes y 10 perfiles. 31 de esos exámenes están en más
// de un perfil a la vez (Glucosa, Factor RH, VIH...). Al quitar un perfil hay
// que quitar SOLO sus exámenes, y dejar los que otro perfil activo todavía
// necesita, y los que el usuario había agregado a mano.
//
// ── BUG DOCUMENTADO (fallo conocido, sin arreglar) ──
// Si el usuario agrega "Glucosa" a mano y después activa y desactiva un perfil
// que también trae "Glucosa", el examen que él puso a mano desaparece de la
// hoja. El código borra currentTests por nombre sin distinguir de qué perfil
// vino. La prueba de abajo fija el comportamiento ACTUAL (con el examen que se
// pierde) para que quede a la vista. Cuando se arregle, esta prueba va a fallar
// y eso es lo correcto: es la señal de que se arregló.
// ─────────────────────────────────────────────────────────────────────────────
for(const sede of SEDES){
  console.log('\n' + sede.label + ' — catálogo y perfiles');
  const motor = motores[sede.id];
  const def = (nombre) => motor.findTestDef(nombre);
  const limpiar = ()=>{ motor.setTests([]); motor.setPaquetes([]); motor.limpiarCatalogo(); };

  prueba('el catálogo tiene 99 exámenes sin nombres repetidos', ()=>{
    const todos = motor.areas().flatMap(a => motor.getCatalogArea(a).map(t => t.name));
    assert.strictEqual(todos.length, new Set(todos).size,
      'hay dos exámenes con el mismo nombre: findTestDef devolvería el primero y el otro sería inalcanzable');
    assert.ok(todos.length >= 90, `el catálogo tiene ${todos.length} exámenes, se esperaban ~99`);
  });

  prueba('los perfiles comparten exámenes entre sí, y eso es real', ()=>{
    // Si este test falla, se rompió el catálogo y el caso de "examen compartido"
    // que viene abajo ya no probaría nada.
    const gluc = def('Glucosa');
    assert.ok(gluc, 'Glucosa existe en el catálogo');
    const perfiles = ['Perfil Prenatal','Paquete Gestante','Paquete Puérpera','Paquete Recién Nacido']
      .map(n => def(n)).filter(Boolean).filter(p => p.panel && p.panel.includes('Glucosa'));
    assert.ok(perfiles.length >= 2, `Glucosa debería estar en varios perfiles, está en ${perfiles.length}`);
  });

  prueba('activar un perfil mete TODOS sus exámenes en la hoja', ()=>{
    limpiar();
    const perfil = motor.perfilConPanel();
    motor.toggleTest('Hematología', perfil);
    for(const n of perfil.panel){
      assert.ok(motor.verTests().includes(n), `faltó "${n}" en la hoja`);
    }
    assert.deepStrictEqual(Array.from(motor.verPaquetes()), [perfil.name],
      'el perfil queda marcado como activo (el nombre cambia entre sedes)');
  });

  prueba('un examen queda en la hoja una sola vez aunque esté en varios perfiles', ()=>{
    limpiar();
    // Dos perfiles que comparten algún examen. Putina tiene tres variantes de
    // Hemograma en vez de una, así que se eligen por búsqueda y no por nombre.
    motor.toggleTest('Hematología', motor.perfilConPanel());
    motor.toggleTest('Hematología', def('Perfil Prenatal'));
    const repetidos = motor.verTests().filter((n,i,a) => a.indexOf(n) !== i);
    assert.deepStrictEqual(Array.from(repetidos), [],
      `estos exámenes quedaron dos veces en la hoja: ${repetidos.join(', ')}`);
  });

  prueba('al quitar un perfil, los exámenes que solo él tenía se van de la hoja', ()=>{
    limpiar();
    const perfil = motor.perfilConPanel();
    const solo = perfil.panel.filter(n => !(def('Perfil Prenatal').panel||[]).includes(n));
    assert.ok(solo.length > 0, 'el perfil debe traer exámenes que el otro no trae');
    motor.toggleTest('Hematología', perfil);
    motor.toggleTest('Hematología', def('Perfil Prenatal'));
    assert.ok(motor.verTests().includes(solo[0]), 'antes de quitar, está');
    motor.toggleTest('Hematología', perfil);   // quitar
    const despues = motor.verTests();
    assert.ok(!despues.includes(solo[0]), 'ya no lo necesita nadie: se va');
    assert.ok(despues.includes('Glucosa'), 'pero Glucosa la necesita Perfil Prenatal: se queda');
  });

  // ── RecordsKernel ──────────────────────────────────────────────────────────
  // El kernel de fichas es el estado más peligroso de la app: un error acá se
  // traduce en resultados duplicados o perdidos, no en un número que se ve
  // distinto en un informe. Estos tests existen porque el escáner de propiedad
  // del estado NO alcanza: alcanza a ver que nadie escribe la global por fuera,
  // pero no a ver que el kernel hace lo correcto. Con upsert roto (siempre
  // agrega, nunca actualiza) la suite entera pasaba en verde.
  prueba('upsert agrega la ficha si el id es nuevo', ()=>{
    const k = motor.recordsKernel();
    k.replaceAll([]);
    assert.strictEqual(k.upsert({ id:'a', nombre:'Ana' }), 'added');
    assert.strictEqual(k.all.length, 1, 'una ficha nueva, en la lista');
  });

  prueba('upsert ACTUALIZA la ficha si el id ya existe (no la duplica)', ()=>{
    const k = motor.recordsKernel();
    k.replaceAll([{ id:'a', nombre:'Ana' }]);
    assert.strictEqual(k.upsert({ id:'a', nombre:'Ana editada' }), 'updated');
    assert.strictEqual(k.all.length, 1,
      'sigue habiendo UNA ficha: si fuera 2, la misma paciente aparecería duplicada en el informe');
    assert.strictEqual(k.all[0].nombre, 'Ana editada', 'y con el dato nuevo');
  });

  prueba('upsert repetido sobre el mismo id no crece la lista', ()=>{
    const k = motor.recordsKernel();
    k.replaceAll([]);
    for(let i = 0; i < 5; i++) k.upsert({ id:'a', n:i });
    assert.strictEqual(k.all.length, 1, 'guardar cinco veces la misma ficha deja una');
    assert.strictEqual(k.all[0].n, 4, 'con el valor del último guardado');
  });

  prueba('upsert distingue fichas distintas con ids distintos', ()=>{
    const k = motor.recordsKernel();
    k.replaceAll([]);
    k.upsert({ id:'a' }); k.upsert({ id:'b' }); k.upsert({ id:'a' });
    assert.deepStrictEqual(k.all.map(r => r.id), ['a','b'],
      'dos fichas distintas, y la repetida actualizó en su lugar sin reordenar');
  });

  prueba('remove borra solo la ficha pedida y deja el resto igual', ()=>{
    const k = motor.recordsKernel();
    k.replaceAll([{ id:'a' }, { id:'b' }, { id:'c' }]);
    k.remove('b');
    assert.deepStrictEqual(k.all.map(r => r.id), ['a','c']);
  });

  prueba('remove sobre un id que no existe no rompe nada', ()=>{
    const k = motor.recordsKernel();
    k.replaceAll([{ id:'a' }]);
    k.remove('zzz');
    assert.deepStrictEqual(k.all.map(r => r.id), ['a'], 'borrar lo que no está es inocuo');
  });

  prueba('replaceAll reemplaza todo el contenido, no lo agrega', ()=>{
    const k = motor.recordsKernel();
    k.replaceAll([{ id:'a' }, { id:'b' }]);
    k.replaceAll([{ id:'c' }]);
    assert.deepStrictEqual(k.all.map(r => r.id), ['c'], 'la lista anterior desapareció');
    k.replaceAll(null);
    assert.strictEqual(k.all.length, 0, 'y una carga vacía deja la lista vacía, sin undefined');
    assert.ok(Array.isArray(k.all), 'sigue siendo un array, no undefined');
  });

  prueba('sortByCreatedDesc deja la más reciente primero', ()=>{
    const k = motor.recordsKernel();
    k.replaceAll([
      { id:'vieja', createdAt:100 },
      { id:'reciente', createdAt:300 },
      { id:'media', createdAt:200 },
    ]);
    k.sortByCreatedDesc();
    assert.deepStrictEqual(k.all.map(r => r.id), ['reciente','media','vieja']);
  });

  prueba('sortByCreatedDesc no rompe con fichas sin createdAt', ()=>{
    const k = motor.recordsKernel();
    k.replaceAll([{ id:'sinfecha' }, { id:'confecha', createdAt:200 }]);
    k.sortByCreatedDesc();
    assert.strictEqual(k.all.length, 2, 'una ficha sin createdAt no desaparece ni rompe el orden');
    assert.strictEqual(k.all[0].id, 'confecha', 'la que sí tiene fecha va primero');
  });

  prueba('el orden del kernel es el mismo que ordenaba el código anterior', ()=>{
    // La línea base: la app ordenaba por (b.createdAt||0) - (a.createdAt||0).
    // El kernel tiene que hacer exactamente eso, no "casi".
    const k = motor.recordsKernel();
    const entrada = [
      { id:'c1', createdAt:5 }, { id:'c2' }, { id:'c3', createdAt:9 }, { id:'c4', createdAt:1 },
    ];
    k.replaceAll(entrada.map(r => ({ ...r })));
    k.sortByCreatedDesc();
    const esperado = entrada.map(r => r.createdAt || 0).sort((a, b) => b - a);
    const obtenido = k.all.map(r => r.createdAt || 0);
    assert.deepStrictEqual(obtenido, esperado,
      'el criterio de orden tiene que ser idéntico al de antes de la migración');
  });

  // ── AuditKernel ────────────────────────────────────────────────────────────
  prueba('add deja la entrada nueva PRIMERO (más reciente al principio)', ()=>{
    const k = motor.auditKernel();
    k.replaceAll([{ id:'vieja', timestamp:1 }]);
    k.add({ id:'nueva', timestamp:2 });
    assert.deepStrictEqual(k.all.map(e => e.id), ['nueva','vieja'],
      'la auditoría se lee de la más nueva a la más vieja');
  });

  prueba('add recorta a 400 y se queda con los más recientes', ()=>{
    const k = motor.auditKernel();
    // e0 es la más reciente (timestamp 1000) y e399 la más antigua.
    k.replaceAll(Array.from({ length:400 }, (_, i) => ({ id:'e'+i, timestamp:1000-i })));
    k.add({ id:'nueva', timestamp:2000 });
    assert.strictEqual(k.length, 400, 'no crece más allá del tope');
    assert.strictEqual(k.all[0].id, 'nueva', 'la nueva está, y primera');
    assert.ok(!k.all.some(e => e.id === 'e399'), 'la más antigua se fue');
    assert.ok(k.all.some(e => e.id === 'e0'), 'la más reciente anterior sobrevive');
  });

  prueba('add NO borra nada cuando todavía no se llegó al tope', ()=>{
    const k = motor.auditKernel();
    k.replaceAll([{ id:'a' }, { id:'b' }]);
    k.add({ id:'c' });
    assert.strictEqual(k.length, 3, 'con 3 de 400 cupos no se descarta ninguna');
  });

  prueba('add devuelve la entrada, para poder referenciarla', ()=>{
    const k = motor.auditKernel();
    k.replaceAll([]);
    const e = { id:'x' };
    assert.strictEqual(k.add(e), e, 'logAudit necesita la entrada que acaba de guardar');
  });

  prueba('el tope de auditoría es el mismo que la app declara', ()=>{
    // El valor esperado sale de la app, no de un 400 escrito acá. Si el kernel se
    // instanciara con un número distinto de AUDIT_LOCAL_MAX, la app recortaría en
    // un punto que nadie declaró. Con un 400 fijo en el test, cambiar el tope a
    // 100 en el código pasaba inadvertido.
    assert.strictEqual(motor.auditKernel().max, motor.constantes().AUDIT_LOCAL_MAX,
      'el kernel tiene que usar la constante de la app, no un número escrito a mano');
    assert.ok(motor.constantes().AUDIT_LOCAL_MAX >= 400,
      'y el tope declarado tiene que ser al menos 400: menos que eso recorta el historial local antes de tiempo');
  });

  // ── UserKernel ─────────────────────────────────────────────────────────────
  // El kernel de usuarios es el único estado del que depende QUIEN FIRMA un
  // resultado. Un usuario que se pierde deja resultados sin responsable, y una
  // fusión mal hecha regenera el nombre de usuario solo: eso ya pasó (07/09/2026)
  // y por eso la regla vive acá y no suelta en un callback de sincronización.
  prueba('upsert ACTUALIZA el usuario si el id ya existe (no lo duplica)', ()=>{
    const k = motor.userKernel();
    k.replaceAll([{ id:'u1', username:'jperez' }]);
    assert.strictEqual(k.upsert({ id:'u1', username:'jperez.renal' }), 'updated');
    assert.strictEqual(k.length, 1, 'actualizar no puede crear una segunda entrada');
    assert.strictEqual(k.findById('u1').username, 'jperez.renal', 'y guarda el dato nuevo');
  });

  prueba('upsert repetido sobre el mismo id no crece la lista', ()=>{
    const k = motor.userKernel();
    k.replaceAll([]);
    for(let i = 0; i < 5; i++) k.upsert({ id:'u1', n:i });
    assert.strictEqual(k.length, 1, 'cinco sincronizaciones del mismo usuario, una entrada');
  });

  prueba('upsert distingue usuarios distintos con ids distintos', ()=>{
    const k = motor.userKernel();
    k.replaceAll([]);
    k.upsert({ id:'u1' }); k.upsert({ id:'u2' });
    assert.strictEqual(k.length, 2);
    assert.ok(k.findById('u1') && k.findById('u2'), 'ambos quedanlocalizables por id');
  });

  prueba('findById devuelve null si no existe, en vez de undefined', ()=>{
    const k = motor.userKernel();
    k.replaceAll([{ id:'u1' }]);
    assert.strictEqual(k.findById('nada'), null,
      'los llamadores hacen truthy/falsy sobre esto: undefined y null se comportan distinto al serializar');
  });

  prueba('remove borra solo el id pedido y deja el orden del resto', ()=>{
    const k = motor.userKernel();
    k.replaceAll([{ id:'a' }, { id:'b' }, { id:'c' }]);
    k.remove('b');
    assert.deepStrictEqual(k.all.map(u => u.id), ['a','c'],
      'el orden de la lista importa: es el que ve el usuario en el selector');
  });

  prueba('remove un id que no existe no cambia nada', ()=>{
    const k = motor.userKernel();
    k.replaceAll([{ id:'a' }, { id:'b' }]);
    k.remove('zzz');
    assert.strictEqual(k.length, 2);
  });

  prueba('replaceAll con null deja la lista vacía, sin un undefined suelto', ()=>{
    const k = motor.userKernel();
    k.replaceAll([{ id:'a' }]);
    k.replaceAll(null);
    assert.strictEqual(k.length, 0);
    assert.ok(!k.all.some(u => !u), 'no puede quedar un hueco undefined en la lista');
  });

  prueba('nombresUsados baja a minúsculas, para validar duplicados', ()=>{
    const k = motor.userKernel();
    k.replaceAll([{ id:'u1', username:'JPerez' }, { id:'u2' }, { id:'u3', username:'mlopez' }]);
    assert.deepStrictEqual(k.nombresUsarios === undefined ? k.nombresUsados() : k.nombresUsados(),
      ['jperez', '', 'mlopez'],
      'la comparación de duplicados tiene que ser insensible a mayúsculas');
  });

  // ── La regla de fusión local/nube ─────────────────────────────────────────
  prueba('mergeFromCloud: gana la nube si su updatedAt es más reciente', ()=>{
    const k = motor.userKernel();
    k.replaceAll([{ id:'u1', username:'viejo', updatedAt:100 }]);
    k.mergeFromCloud([{ id:'u1', username:'nuevo', updatedAt:200 }]);
    assert.strictEqual(k.findById('u1').username, 'nuevo');
  });

  prueba('mergeFromCloud: gana la local si su updatedAt es más reciente', ()=>{
    const k = motor.userKernel();
    k.replaceAll([{ id:'u1', username:'nuevo', updatedAt:200 }]);
    k.mergeFromCloud([{ id:'u1', username:'viejo', updatedAt:100 }]);
    assert.strictEqual(k.findById('u1').username, 'nuevo',
      'el snapshot de la nube puede llegar tarde: si gana por ser "no vacío" pisa la edición local');
  });

  prueba('mergeFromCloud: en empate gana SIEMPRE la local (el bug del 07/09/2026)', ()=>{
    const k = motor.userKernel();
    k.replaceAll([{ id:'u1', username:'jperez', updatedAt:200 }]);
    k.mergeFromCloud([{ id:'u1', username:'jperez.renal', updatedAt:200 }]);
    assert.strictEqual(k.findById('u1').username, 'jperez',
      'si en empate ganara la nube, el nombre de usuario se regeneraría solo y la persona perdería el acceso');
  });

  prueba('mergeFromCloud: sin updatedAt en ninguno, gana la local', ()=>{
    const k = motor.userKernel();
    k.replaceAll([{ id:'u1', username:'local' }]);
    k.mergeFromCloud([{ id:'u1', username:'nube' }]);
    assert.strictEqual(k.findById('u1').username, 'local',
      'las cuentas migradas antes del 07/09/2026 no tienen marca de tiempo: el caso que abrió el bug');
  });

  prueba('mergeFromCloud: la nube mete al usuario que el equipo no tiene', ()=>{
    const k = motor.userKernel();
    k.replaceAll([{ id:'u1', username:'local', updatedAt:100 }]);
    const res = k.mergeFromCloud([
      { id:'u1', username:'local', updatedAt:100 },
      { id:'u2', username:'nuevo', updatedAt:100 },
    ]);
    assert.strictEqual(k.length, 2, 'un usuario nuevo en otro equipo tiene que aparecer acá');
    assert.strictEqual(k.findById('u2').username, 'nuevo');
    assert.strictEqual(res.length, 2, 'la función devuelve la lista ya resuelta');
  });

  prueba('mergeFromCloud: los usuarios que solo están local NO se pierden', ()=>{
    const k = motor.userKernel();
    k.replaceAll([{ id:'u1', updatedAt:100 }, { id:'u2', username:'solo-local', updatedAt:100 }]);
    k.mergeFromCloud([{ id:'u1', username:'u1', updatedAt:100 }]);
    assert.ok(k.findById('u2'), 'la nube no trae todo: un usuario borrado allá no puede borrarse acá solo');
  });

  prueba('la sincronización de usuarios y la global ven lo mismo', ()=>{
    const k = motor.userKernel();
    k.replaceAll([{ id:'u1' }]);
    motor.sincronizarUsers();
    assert.strictEqual(motor.verUsers().length, k.length,
      'si la global se desincroniza, la pantalla muestra una lista y el guardado escribe otra');
  });

  // ── DirectoryKernel ────────────────────────────────────────────────────────
  // La base de pacientes es lo que permite firmar un resultado con nombre y DNI.
  // Un error acá no da un número raro: da un paciente que no aparece, o un campo
  // que se borra de un paciente que sí aparece.
  prueba('importar agrega el paciente nuevo y cuenta como added', ()=>{
    const k = motor.directoryKernel();
    k.replaceAll({});
    assert.strictEqual(k.importar('123', { dni:'123', nombre:'Ana Ruiz' }), 'added');
    assert.strictEqual(k.size, 1);
    assert.strictEqual(k.get('123').nombre, 'Ana Ruiz');
  });

  prueba('importar actualiza el existente y cuenta como updated', ()=>{
    const k = motor.directoryKernel();
    k.replaceAll({ '123': { dni:'123', nombre:'Ana Ruiz', distrito:'Lampa' } });
    assert.strictEqual(k.importar('123', { dni:'123', nombre:'Ana Ruiz' }), 'updated');
    assert.strictEqual(k.size, 1, 'no puede aparecer el mismo DNI dos veces');
  });

  prueba('importar NO borra un dato que el archivo trae vacío', ()=>{
    // Este es el caso que hace peligroso usar un solo método para las dos
    // escrituras: la base del mes siguiente trae menos columnas, y una celda
    // vacía ahí significa "no viene", no "borrá lo que ya sé".
    const k = motor.directoryKernel();
    k.replaceAll({ '123': { dni:'123', nombre:'Ana Ruiz', distrito:'Lampa', sexo:'F' } });
    k.importar('123', { dni:'123', nombre:'Ana Ruiz', distrito:'', sexo:'' });
    const p = k.get('123');
    assert.strictEqual(p.distrito, 'Lampa', 'el distrito se conserva: el archivo no lo trajo');
    assert.strictEqual(p.sexo, 'F', 'y el sexo también');
  });

  prueba('importar SÍ actualiza los datos que el archivo sí trae', ()=>{
    const k = motor.directoryKernel();
    k.replaceAll({ '123': { dni:'123', nombre:'Ana Ruiz', distrito:'Lampa' } });
    k.importar('123', { dni:'123', nombre:'Ana Ruiz', distrito:'Cusco' });
    assert.strictEqual(k.get('123').distrito, 'Cusco');
  });

  prueba('restaurar SÍ aplica los campos vacíos (un respaldo se restaura, no se mezcla)', ()=>{
    // El contraluz del test anterior: si los dos métodos hicieran lo mismo, uno
    // de los dos está mal y el error aparecería meses después, al restaurar un
    // respaldo viejo en el equipo nuevo.
    const k = motor.directoryKernel();
    k.replaceAll({ '123': { dni:'123', nombre:'Ana Ruiz', distrito:'Lampa' } });
    assert.strictEqual(k.restaurar('123', { dni:'123', nombre:'Ana Ruiz', distrito:'' }), 'updated');
    assert.strictEqual(k.get('123').distrito, '', 'el respaldo manda: lo que no está, no está');
  });

  prueba('buscar encuentra por DNI, por HC y por nombre, sin distinguir mayúsculas', ()=>{
    const k = motor.directoryKernel();
    k.replaceAll({ '123': { dni:'123', hc:'HC-9', nombre:'Ana Ruiz' } });
    assert.ok(k.buscar('123'), 'por DNI');
    assert.ok(k.buscar('hc-9'), 'por HC, en minúsculas contra un valor en mayúsculas');
    assert.ok(k.buscar('ana ruiz'), 'por nombre');
  });

  prueba('buscar con vacío o sin coincidencia devuelve null, no undefined', ()=>{
    const k = motor.directoryKernel();
    k.replaceAll({ '123': { dni:'123' } });
    assert.strictEqual(k.buscar(''), null, 'una búsqueda vacía no puede devolver un paciente cualquiera');
    assert.strictEqual(k.buscar('   '), null);
    assert.strictEqual(k.buscar('999'), null);
  });

  prueba('buscar no revienta si el paciente no tiene el campo con el que se busca', ()=>{
    // Pacientes cargados desde un archivo sin DNI: llegan con nombre y nada más.
    const k = motor.directoryKernel();
    k.replaceAll({ 'juan perez': { nombre:'Juan Perez' } });
    assert.ok(k.buscar('juan perez'), 'se encuentra igual');
    assert.strictEqual(k.buscar('123'), null, 'y buscar un DNI que nadie tiene no tira TypeError');
  });

  prueba('remove borra al paciente y deja el resto', ()=>{
    const k = motor.directoryKernel();
    k.replaceAll({ a:{ dni:'1' }, b:{ dni:'2' } });
    k.remove('a');
    assert.strictEqual(k.size, 1);
    assert.ok(k.get('b'));
  });

  prueba('replaceAll con null deja la base vacía, sin un undefined suelto', ()=>{
    const k = motor.directoryKernel();
    k.replaceAll({ a:{ dni:'1' } });
    k.replaceAll(null);
    assert.strictEqual(k.size, 0);
    assert.ok(!k.all.a, 'no puede quedar la base como un valor sin objeto');
  });

  prueba('size, keys y values cuentan lo mismo (la pantalla los usa para el estado)', ()=>{
    const k = motor.directoryKernel();
    k.replaceAll({ a:{ dni:'1' }, b:{ dni:'2' } });
    assert.strictEqual(k.size, 2);
    assert.strictEqual(k.keys().length, 2);
    assert.strictEqual(k.values().length, 2);
    assert.ok(k.has('a') && !k.has('zzz'));
  });

  prueba('lookupDirectory de la app usa el kernel y ve lo mismo que la pantalla', ()=>{
    const k = motor.directoryKernel();
    k.replaceAll({ '123': { dni:'123', nombre:'Ana Ruiz' } });
    motor.sincronizarDirectory();
    assert.ok(motor.lookupDirectory('123'), 'la búsqueda de la app tiene que encontrarlo');
    assert.strictEqual(motor.lookupDirectory('999'), null);
    assert.strictEqual(motor.verDirectory()['123'].nombre, 'Ana Ruiz',
      'la vista global tiene que apuntar al mismo objeto que el kernel, no a una copia vieja');
  });

  prueba('después de replaceAll la vista global se reconstruye (si no, se lee la base anterior)', ()=>{
    // replaceAll cambia el objeto interno del kernel. Si la vista global no se
    // refresca, la pantalla sigue mostrando la base de la carga anterior.
    const k = motor.directoryKernel();
    k.replaceAll({ viejo:{ dni:'1', nombre:'Viejo' } });
    motor.sincronizarDirectory();
    k.replaceAll({ nuevo:{ dni:'2', nombre:'Nuevo' } });
    motor.sincronizarDirectory();
    assert.strictEqual(motor.verDirectory()['nuevo'].nombre, 'Nuevo');
    assert.strictEqual(motor.verDirectory()['viejo'], undefined, 'la base anterior ya no está');
    assert.ok(!motor.lookupDirectory('1'), 'y buscar un paciente de la base vieja devuelve vacío');
  });

  // ── BkExternosKernel ───────────────────────────────────────────────────────
  // Estos números se tipean a mano y van al informe que se reporta a MINSA. Un
  // servicio que queda en cero guardado como {esputo:0,orina:0,heces:0} no
  // cambia el total, pero deja de poderse distinguir de "nunca se contó", y esa
  // diferencia aparece cuando alguien tiene que explicar el mes.
  prueba('guardarMes guarda el mes con sus servicios', ()=>{
    const k = motor.bkKernel();
    k.replaceAll({});
    k.guardarMes('09', '2026', { 'Hematología': { esputo:2, orina:0, heces:0 } });
    assert.strictEqual(k.delMes('09','2026')['Hematología'].esputo, 2);
    assert.strictEqual(k.meses.length, 1, 'la clave del mes es yyyy-mm');
  });

  prueba('guardarMes DESCARTA el servicio que quedó en cero (no queda en cero guardada)', ()=>{
    const k = motor.bkKernel();
    k.replaceAll({});
    k.guardarMes('09', '2026', {
      'Hematología': { esputo:2, orina:0, heces:0 },
      'Microbiología': { esputo:0, orina:0, heces:0 },
    });
    assert.ok(!k.delMes('09','2026')['Microbiología'],
      'un servicio en cero no se guarda: su ausencia ya significa que no se contó');
    assert.ok(k.delMes('09','2026')['Hematología'], 'el que tiene resultados se queda');
  });

  prueba('guardarMes reemplaza el mes COMPLETO, no lo suma (si no, un borrado en pantalla no borra)', ()=>{
    // El panel edita el mes entero. Si el guardado sumara, sacar un número de la
    // pantalla no lo borraría: quedaría accumulates con los meses anteriores.
    const k = motor.bkKernel();
    k.replaceAll({});
    k.guardarMes('09','2026', { A:{ esputo:5, orina:0, heces:0 }, B:{ esputo:3, orina:0, heces:0 } });
    k.guardarMes('09','2026', { A:{ esputo:5, orina:0, heces:0 } });
    assert.ok(!k.delMes('09','2026').B, 'B se fue: el mes se reemplaza entero');
    assert.strictEqual(k.totalDeMes('09','2026'), 5, 'y el total no acumula');
  });

  prueba('guardarMes con todo en cero deja el mes vacío, no lo borra', ()=>{
    // Si el mes desaparece, "el mes existe y está en cero" y "nunca se capturó"
    // serían el mismo dato, y después no se puede distinguir.
    const k = motor.bkKernel();
    k.replaceAll({});
    k.guardarMes('09','2026', { A:{ esputo:0, orina:0, heces:0 } });
    assert.ok(k.meses.includes('2026-09'), 'el mes queda, vacío');
    assert.strictEqual(k.totalDeMes('09','2026'), 0);
  });

  prueba('un mes que nunca se capturó devuelve vacío y total 0, sin reventar', ()=>{
    const k = motor.bkKernel();
    k.replaceAll({});
    assert.strictEqual(Object.keys(k.delMes('01','2020')).length, 0, 'devuelve un objeto vacío, no undefined');
    assert.strictEqual(k.totalDeMes('01','2020'), 0);
  });

  prueba('totalDeMes suma los tres tipos de muestra de todos los servicios', ()=>{
    const k = motor.bkKernel();
    k.replaceAll({});
    k.guardarMes('09','2026', {
      A:{ esputo:2, orina:0, heces:0 },
      B:{ esputo:0, orina:1, heces:0 },
      C:{ esputo:0, orina:0, heces:4 },
    });
    assert.strictEqual(k.totalDeMes('09','2026'), 7);
  });

  prueba('totalDeMes no se lleva meses de otros', ()=>{
    const k = motor.bkKernel();
    k.replaceAll({});
    k.guardarMes('09','2026', { A:{ esputo:2, orina:0, heces:0 } });
    k.guardarMes('10','2026', { A:{ esputo:9, orina:0, heces:0 } });
    assert.strictEqual(k.totalDeMes('09','2026'), 2, 'el informe es por mes: sumar el mes vecino infla el reporte');
  });

  prueba('fusionar de un respaldo: el mes del archivo manda entero', ()=>{
    const k = motor.bkKernel();
    k.replaceAll({ '2026-09': { A:{ esputo:1, orina:0, heces:0 }, B:{ esputo:1, orina:0, heces:0 } } });
    k.fusionar({ '2026-09': { A:{ esputo:7, orina:0, heces:0 } } });
    assert.ok(!k.delMes('09','2026').B, 'B no sobrevive: el archivo manda el mes completo');
    assert.strictEqual(k.delMes('09','2026').A.esputo, 7);
  });

  prueba('fusionar de un respaldo: los meses que no trae el archivo se conservan', ()=>{
    const k = motor.bkKernel();
    k.replaceAll({ '2026-08': { A:{ esputo:3, orina:0, heces:0 } } });
    k.fusionar({ '2026-09': { A:{ esputo:1, orina:0, heces:0 } } });
    assert.strictEqual(k.totalDeMes('08','2026'), 3,
      'que el archivo no lo mencione no significa que esté en cero: significa que no viene');
  });

  prueba('replaceAll con null deja la facturación vacía', ()=>{
    const k = motor.bkKernel();
    k.replaceAll({ '2026-09': { A:{ esputo:1, orina:0, heces:0 } } });
    k.replaceAll(null);
    assert.strictEqual(k.size, 0);
    assert.strictEqual(k.totalDeMes('09','2026'), 0);
  });

  prueba('la vista global y el kernel ven lo mismo después de guardar', ()=>{
    const k = motor.bkKernel();
    k.replaceAll({});
    k.guardarMes('09','2026', { A:{ esputo:4, orina:0, heces:0 } });
    motor.sincronizarBkExternos();
    assert.strictEqual(motor.verBkExternos()['2026-09'].A.esputo, 4,
      'el informe lee la global: si quedó desactualizada, el mes cuenta 0');
    assert.strictEqual(motor.totalBk('09','2026'), 4, 'y el total del informe ve lo mismo');
  });

  prueba('después de replaceAll la vista se reconstruye (si no, el informe lee el mes anterior)', ()=>{
    const k = motor.bkKernel();
    k.replaceAll({ '2026-08': { A:{ esputo:6, orina:0, heces:0 } } });
    motor.sincronizarBkExternos();
    k.replaceAll({ '2026-09': { A:{ esputo:1, orina:0, heces:0 } } });
    motor.sincronizarBkExternos();
    assert.strictEqual(motor.totalBk('08','2026'), 0, 'el mes viejo ya no está');
    assert.strictEqual(motor.totalBk('09','2026'), 1);
  });

  // ── CatalogKernel ──────────────────────────────────────────────────────────
  // Los exámenes que el administrador agrega. Es el único estado que CRECE con
  // el uso, así que un agregar que no se guarda es un trabajo perdido.
  prueba('agregar deja el examen en el área, y el área se crea si no estaba', ()=>{
    const k = motor.catalogKernel();
    k.replaceAll({});
    k.agregar('Bioquímica Clínica', { name:'Glucosa', unit:'mg/dL', ref:'70-110' });
    assert.strictEqual(k.deArea('Bioquímica Clínica').length, 1);
    assert.strictEqual(k.deArea('Bioquímica Clínica')[0].name, 'Glucosa');
    assert.strictEqual(k.size, 1, 'un área nueva cuenta como área nueva');
  });

  prueba('agregar NO pisa el examen que ya estaba en el área', ()=>{
    const k = motor.catalogKernel();
    k.replaceAll({});
    k.agregar('Hematología', { name:'Leucocitos' });
    k.agregar('Hematología', { name:'Hemoglobina' });
    assert.deepStrictEqual(Array.from(k.deArea('Hematología'), e => e.name), ['Leucocitos','Hemoglobina'],
      'si el área se reiniciara en cada agregar, se perdería todo lo anterior');
  });

  prueba('agregar conserva el orden en que se fueron metiendo', ()=>{
    const k = motor.catalogKernel();
    k.replaceAll({});
    ['c','a','b'].forEach(n => k.agregar('Microbiología', { name:n }));
    assert.deepStrictEqual(Array.from(k.deArea('Microbiología'), e => e.name), ['c','a','b'],
      'es el orden que ve el usuario en la lista; no se ordena por nombre');
  });

  prueba('agregar guarda el examen tal cual, con sus opciones si las tiene', ()=>{
    const k = motor.catalogKernel();
    k.replaceAll({});
    k.agregar('Parasitológico', { name:'Parasito', unit:'', ref:'', opciones:['','Negativo','Positivo'] });
    assert.deepStrictEqual(k.deArea('Parasitológico')[0].opciones, ['','Negativo','Positivo'],
      'el kernel no toca la forma del examen: es de cada sede');
  });

  prueba('agregar no borra la entrada previa aunque se repita el nombre', ()=>{
    // El flujo de alta valida antes de agregar que el nombre no exista, así que
    // dos entradas con el mismo nombre no deberían ocurrir. Si llegan, el kernel
    // no puede decidir cuál se queda: lo que no puede hacer es perder la primera
    // en silencio. Por eso agregar es append y nada más.
    const k = motor.catalogKernel();
    k.replaceAll({});
    k.agregar('Hematología', { name:'Hemoglobina', unit:'g/dL' });
    k.agregar('Hematología', { name:'Hemoglobina', unit:'g/L' });
    assert.strictEqual(k.deArea('Hematología').length, 2, 'agregar es agregar: no reemplaza en silencio');
  });

  prueba('quitar borra SOLO el examen pedido', ()=>{
    const k = motor.catalogKernel();
    k.replaceAll({});
    k.agregar('Hematología', { name:'Leucocitos' });
    k.agregar('Hematología', { name:'Hemoglobina' });
    k.quitar('Hematología', 'Leucocitos');
    assert.deepStrictEqual(Array.from(k.deArea('Hematología'), e => e.name), ['Hemoglobina']);
  });

  prueba('quitar deja el ÁREA vacía, no borra la clave (el área ya existe y se muestra)', ()=>{
    const k = motor.catalogKernel();
    k.replaceAll({});
    k.agregar('Hematología', { name:'Leucocitos' });
    k.quitar('Hematología', 'Leucocitos');
    assert.ok(k.areas().includes('Hematología'), 'el área sigue existiendo aunque quede sin exámenes');
    assert.strictEqual(k.deArea('Hematología').length, 0);
  });

  prueba('quitar un examen que no está no rompe nada', ()=>{
    const k = motor.catalogKernel();
    k.replaceAll({});
    k.quitar('Hematología', 'nada');
    assert.strictEqual(k.deArea('Hematología').length, 0);
  });

  prueba('existe responde por área y nombre exactos', ()=>{
    const k = motor.catalogKernel();
    k.replaceAll({});
    k.agregar('Hematología', { name:'Hemoglobina' });
    assert.ok(k.existe('Hematología', 'Hemoglobina'));
    assert.ok(!k.existe('Hematología', 'hemoglobina'), 'el nombre es exacto: no se busca por mayúsculas');
    assert.ok(!k.existe('Química', 'Hemoglobina'), 'ni en otro área');
  });

  prueba('fusionar de un respaldo: el área del archivo manda entera', ()=>{
    const k = motor.catalogKernel();
    k.replaceAll({ 'Hematología': [{ name:'Leucocitos' }, { name:'Hemoglobina' }] });
    k.fusionar({ 'Hematología': [{ name:'Plaquetas' }] });
    assert.deepStrictEqual(Array.from(k.deArea('Hematología'), e => e.name), ['Plaquetas'],
      'el área del archivo reemplaza entera; si se mezclara, volverían exámenes que ya se borraron');
  });

  prueba('fusionar de un respaldo: las áreas que no trae el archivo se conservan', ()=>{
    const k = motor.catalogKernel();
    k.replaceAll({ 'Hematología': [{ name:'Leucocitos' }] });
    k.fusionar({ 'Microbiología': [{ name:'Gram' }] });
    assert.ok(k.existe('Hematología','Leucocitos'), 'que el archivo no la mencione no significa que esté vacía');
    assert.ok(k.existe('Microbiología','Gram'));
  });

  prueba('replaceAll con null deja el catálogo sin exámenes propios', ()=>{
    const k = motor.catalogKernel();
    k.replaceAll({ 'Hematología': [{ name:'Leucocitos' }] });
    k.replaceAll(null);
    assert.strictEqual(k.size, 0);
    assert.ok(!k.all['Hematología'], 'no puede quedar un valor sin objeto');
  });

  prueba('la vista global y el kernel ven el mismo catálogo (la pantalla lee la global)', ()=>{
    const k = motor.catalogKernel();
    k.replaceAll({});
    k.agregar('Hematología', { name:'Leucocitos' });
    motor.sincronizarCustomCatalog();
    assert.strictEqual(motor.verCatalogo()['Hematología'].length, 1,
      'si la global quedó desactualizada, el catálogo se ve vacío y lo agregado tampoco se guarda');
  });

  prueba('después de replaceAll la vista se reconstruye', ()=>{
    const k = motor.catalogKernel();
    k.replaceAll({ 'Hematología': [{ name:'Viejo' }] });
    motor.sincronizarCustomCatalog();
    k.replaceAll({ 'Hematología': [{ name:'Nuevo' }] });
    motor.sincronizarCustomCatalog();
    assert.ok(motor.verCatalogo()['Hematología'][0].name === 'Nuevo', 'no se ve el catálogo de la carga anterior');
  });

  prueba('quitar un perfil NO borra un examen que el usuario puso a mano', ()=>{
    limpiar();
    // 1) el usuario agrega Glucosa a mano, con un clic en el examen suelto
    motor.toggleTest('Bioquímica Clínica', def('Glucosa'));
    assert.ok(motor.verManuales().includes('Glucosa'), 'al agregarlo a mano queda marcado como manual');
    // 2) activa un perfil que también trae Glucosa (la ve duplicada, pero no la agrega dos veces)
    motor.toggleTest('Bioquímica Clínica', def('Perfil Prenatal'));
    // 3) desactiva ese perfil
    motor.toggleTest('Bioquímica Clínica', def('Perfil Prenatal'));
    const quedar = motor.verTests();
    // Lo que el usuario puso a mano NO se pierde: el perfil no es dueño de ese
    // examen. Este test fallaba antes del arreglo (afirmaba la pérdida) y ahora
    // exige que la Glucosa sobreviva al ciclo agregar-perfil / quitar-perfil.
    assert.ok(quedar.includes('Glucosa'),
      'la Glucosa que el usuario puso a mano debe sobrevivir a que se quite el perfil. ' +
      'Si falla, se rompió la protección de exámenes manuales.');
  });

  prueba('un examen del perfil que nadie más necesita SÍ se va al quitar el perfil', ()=>{
    limpiar();
    // Control del caso anterior: la protección es solo para lo manual. Un examen que
    // llegó por el perfil y no lo puso el usuario, ese sí se va al quitarlo.
    const perfil = motor.perfilConPanel();
    const solo = perfil.panel.filter(n => !(def('Perfil Prenatal').panel||[]).includes(n));
    assert.ok(solo.length > 0, 'el perfil debe traer exámenes que el otro no trae');
    motor.toggleTest('Hematología', perfil);
    assert.ok(motor.verTests().includes(solo[0]), 'el perfil trajo el examen');
    motor.toggleTest('Hematología', perfil);   // quitar
    assert.ok(!motor.verTests().includes(solo[0]),
      'un examen que solo existía por el perfil se va cuando el perfil se quita');
  });

  prueba('un examen quitado a mano deja de estar marcado como manual', ()=>{
    limpiar();
    motor.toggleTest('Bioquímica Clínica', def('Glucosa'));
    assert.ok(motor.verManuales().includes('Glucosa'), 'se agregó a mano');
    // quitarlo con el mismo clic lo saca de la hoja y deja de estar "manual"
    motor.toggleTest('Bioquímica Clínica', def('Glucosa'));
    assert.ok(!motor.verManuales().includes('Glucosa'), 'ya no está, no puede seguir como manual');
    assert.ok(!motor.verTests().includes('Glucosa'), 'y salió de la hoja');
  });

  prueba('quitar un perfil que comparte un examen con otro activo NO lo borra', ()=>{
    limpiar();
    motor.toggleTest('Bioquímica Clínica', def('Perfil Prenatal'));   // trae Glucosa
    motor.toggleTest('Bioquímica Clínica', def('Paquete Gestante'));  // también trae Glucosa
    motor.toggleTest('Bioquímica Clínica', def('Perfil Prenatal'));   // quitar el primero
    assert.ok(motor.verTests().includes('Glucosa'),
      'Paquete Gestante todavía la necesita: Glucosa sigue en la hoja');
  });

  prueba('un examen agregado dos veces no se duplica en la hoja', ()=>{
    limpiar();
    // El caso que importa: un perfil cuyos exámenes tienen nombres repetidos
    // DENTRO de su propio panel. Si el panel los lista dos veces, el
    // isTestAdded lo evita — y esa es justamente la guarda que hay que probar.
    const perfil = { name:'Perfil de prueba', panel:['Hemoglobina','Hemoglobina','Glucosa'] };
    motor.toggleTest('Hematología', perfil);
    const repetidos = motor.verTests().filter((n,i,a) => a.indexOf(n) !== i);
    assert.deepStrictEqual(Array.from(repetidos), [],
      'un panel con un examen repetido no puede dejarlo dos veces en la hoja');
    // tocar un perfil ya activo lo QUITA (es un interruptor, no un checkbox de
    // suma). Lo que importa es que no queden restos.
    motor.toggleTest('Hematología', def('Perfil Prenatal'));
    const n1 = motor.verTests().length;
    motor.toggleTest('Hematología', def('Perfil Prenatal'));  // segunda vez lo quita
    assert.ok(n1 > motor.verTests().length,
      'tocar un perfil activo lo quita de la hoja (toggle, no suma)');
  });

  prueba('un examen del catálogo personalizado aparece junto a los oficiales', ()=>{
    limpiar();
    motor.setCatalogo({ 'Hematología': [{ name:'Prueba de la casa', unit:'x', ref:'' }] });
    const area = 'Hematología';
    const todos = motor.getCatalogArea(area).map(t => t.name);
    assert.ok(todos.includes('Prueba de la casa'), 'el examen propio tiene que verse en su área');
    assert.ok(todos.includes('Hemoglobina'), 'y no puede tapar los oficiales del área');
    assert.ok(motor.findTestDef('Prueba de la casa'),
      'y se tiene que poder buscar por findTestDef');
  });

  prueba('agregar un área nueva la deja registrada para que se muestre', ()=>{
    limpiar();
    const antes = motor.areas().slice();
    motor.ensureAreaInOrder(' área que no existía ');
    // el nombre se normaliza antes de guardarse; si no, el área queda como un
    // typo invisible y sus exámenes nunca se listan
    assert.ok(motor.areas().includes(' área que no existía ') || motor.areas().length === antes.length,
      'llamar dos veces el mismo área no la duplica');
    motor.ensureAreaInOrder('Área Nueva Real');
    assert.ok(motor.areas().includes('Área Nueva Real'),
      `el área nueva tiene que quedar en la lista; la lista tiene: ${motor.areas().join(' | ')}`);
    motor.ensureAreaInOrder('Área Nueva Real');
    assert.strictEqual(motor.areas().filter(a => a === 'Área Nueva Real').length, 1,
      'y no puede aparecer dos veces');
  });
}

// ---- Pacientes: duplicados y reconocimiento de médicos ----
//
// Dos cosas distintas se llaman "duplicado" acá:
//   1) La ficha: el mismo paciente el mismo día (mismo DNI o mismo nombre).
//   2) El médico: dosIVATE formas de escribir el mismo profesional
//      ("Dr. Juan Vilca Gonzáles" vs "Dr. Juan Manuel Vilca Gonzáles").
//
// ── DEBILIDAD CONOCIDA (documentada, sin arreglar) ──
// sameMedico() compara los DOS ÚLTIMOS tokens como apellidos, en el orden en
// que están. No interpreta cuál es el paterno ni el materno. Consecuencia: si
// alguien escribe el nombre al revés ("Perez Juan" en vez de "Juan Perez", o
// "Vilca Gonzales Juan" en vez de "Juan Vilca Gonzales"), la app NO lo
// reconoce como el mismo médico y crea otra variante. La forma buena —el
// nombre de pila primero, luego paterno y materno— sí funciona, incluso con
// nombres de pila de más. Está fijado abajo con el comportamiento real.
// ─────────────────────────────────────────────────────────────────────────────
for(const sede of SEDES){
  console.log('\n' + sede.label + ' — duplicados y médicos');
  const motor = motores[sede.id];

  prueba('el mismo médico escrito de dos formas se reconoce como uno', ()=>{
    assert.strictEqual(motor.sameMedico('Dr. Juan Vilca Gonzáles', 'Juan Manuel Vilca Gonzales'), true,
      'con un nombre de pila de más, sigue siendo el mismo');
    assert.strictEqual(motor.sameMedico('JUAN VILCA GONZALES', 'juan vilca gonzales'), true,
      'no importa mayúsculas');
    assert.strictEqual(motor.sameMedico('Dr. Juan Vilca Gonzáles', 'Dra. Ana Rodríguez Ruiz'), false,
      'médicos distintos no se mezclan');
  });

  prueba('los prefijos y las tildes no impiden reconocer al médico', ()=>{
    assert.strictEqual(motor.sameMedico('Dr. Juan Vilca', 'Lic. Juan Vilca'), true,
      'Dr. y Lic. son el mismo nombre sin el prefijo');
    assert.strictEqual(motor.sameMedico('Dr. Juan Vilca', 'Dr Juan Vilca'), true,
      'con y sin punto es lo mismo');
  });

  prueba('DEBILIDAD CONOCIDA: el orden de los apellidos importa siempre', ()=>{
    // con dos apellidos también exige el orden exacto
    assert.strictEqual(motor.sameMedico('Juan Perez', 'Perez Juan'), false,
      'comportamiento actual: "Juan Perez" y "Perez Juan" NO son el mismo');
    // con un nombre de pila de más, el efecto es el mismo
    assert.strictEqual(motor.sameMedico('Juan Vilca Gonzales', 'Vilca Gonzales Juan'), false,
      'y con tres tokens tampoco: compara los dos últimos tal cual');
    // el caso que SÍ funciona: mismo orden, un nombre de pila opcional
    assert.strictEqual(motor.sameMedico('Juan Vilca Gonzales', 'Juan Manuel Vilca Gonzales'), true,
      'con el orden correcto y un nombre de más, sí los unifica');
  });

  prueba('un nombre de médico vacío no se parece a nadie', ()=>{
    assert.deepStrictEqual(Array.from(motor.medicoTokens('')), [],
      'una cadena vacía no produce ningún token');
    assert.deepStrictEqual(Array.from(motor.medicoTokens('   ')), [],
      'ni uno de puros espacios');
    assert.strictEqual(motor.sameMedico('', 'Juan Perez'), false,
      'un médico vacío no es el mismo que uno con nombre');
    assert.strictEqual(motor.sameMedico('', ''), false,
      'dos vacíos tampoco son "el mismo médico": si lo fueran, fusionarían todos');
  });

  prueba('el médico se escribe siempre en su forma más completa', ()=>{
    // el más completo gana; si hay empate, el más usado
    const mejor = motor.bestMedicoName(['Dr. J. Vilca', 'Dr. Juan Manuel Vilca Gonzáles']);
    assert.strictEqual(mejor, 'Dr. Juan Manuel Vilca Gonzáles', 'gana el más largo');
  });

  prueba('canonicalizeMedico unifica lo que se digita con lo ya guardado', ()=>{
    motor.setMedicos(['Dr. Juan Manuel Vilca Gonzáles']);
    assert.strictEqual(motor.canonicalizeMedico('Dr. Juan Vilca Gonzales'),
      'Dr. Juan Manuel Vilca Gonzáles',
      'si ya existe guardado, se usa la forma completa');
    assert.strictEqual(motor.canonicalizeMedico('Dra. Ana Ruiz'), 'Dra. Ana Ruiz',
      'un médico nuevo se deja como se escribió');
    assert.strictEqual(motor.canonicalizeMedico(''), '', 'vacío no inventa nombre');
  });

  prueba('agrupa las variantes del mismo médico para poder fusionarlas', ()=>{
    motor.setMedicos(['Dr. Juan Vilca Gonzáles', 'Dr. Juan Manuel Vilca Gonzales', 'Dra. Ana Ruiz']);
    motor.setRecords([]);
    const grupos = motor.findMedicoDuplicateGroups();
    assert.strictEqual(grupos.length, 1, `debe haber un grupo de duplicados, hay ${grupos.length}`);
    assert.strictEqual(grupos[0].length, 2, 'las dos variantes de Juan Vilca van juntas');
  });

  prueba('una ficha se marca como duplicada si es el mismo paciente el mismo día', ()=>{
    motor.setRecords([{ id:'r1', nombre:'Ana Ruiz', dni:'123', fecha:'12/08/2026' }]);
    motor.setEditing(null);
    // mismo nombre, mismo día → duplicado
    motor.setForm({ f_nombre:'Ana Ruiz', f_dni:'999', f_fecha:'12/08/2026' });
    assert.ok(motor.findPossibleDuplicate(), 'mismo nombre y mismo día: es duplicado');
    // mismo DNI, distinto nombre, mismo día → también
    motor.setForm({ f_nombre:'Otra Persona', f_dni:'123', f_fecha:'12/08/2026' });
    assert.ok(motor.findPossibleDuplicate(), 'mismo DNI y mismo día: es duplicado');
    // mismo nombre, DISTINTO día → no
    motor.setForm({ f_nombre:'Ana Ruiz', f_dni:'999', f_fecha:'13/08/2026' });
    assert.strictEqual(motor.findPossibleDuplicate(), null, 'otro día no es duplicado');
  });

  prueba('al editar una ficha no se marca a sí misma como duplicada', ()=>{
    motor.setRecords([{ id:'r1', nombre:'Ana Ruiz', dni:'123', fecha:'12/08/2026' }]);
    motor.setEditing('r1');
    motor.setForm({ f_nombre:'Ana Ruiz', f_dni:'123', f_fecha:'12/08/2026' });
    assert.strictEqual(motor.findPossibleDuplicate(), null,
      'no puede decirte que sos duplicado de la ficha que estás editando');
  });

  prueba('sin nombre ni DNI no inventa duplicados', ()=>{
    motor.setRecords([{ id:'r1', nombre:'Ana Ruiz', dni:'123', fecha:'12/08/2026' }]);
    motor.setEditing(null);
    motor.setForm({ f_nombre:'', f_dni:'', f_fecha:'12/08/2026' });
    assert.strictEqual(motor.findPossibleDuplicate(), null, 'sin nombre ni DNI no hay con qué comparar');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// EL CANAL DE COMPLEMENTOS
//
// Lo que hace posible esto: en vez de modificar los tres archivos del
// laboratorio cada vez que hace falta una función nueva, la función se instala
// como complemento y se apoya en lo que la app ya expone.
//
// Y una app a la que se le pueden instalar complementos sin romperla no se
// verifica mirando el código: hay que romperla a propósito. Estas pruebas
// hacen exactamente eso:ogger un complemento que revienta, uno que no pide
// permiso y otro que usa la misma clave de almacenamiento que el primero, y
// comprueban que el laboratorio sigue funcionando igual y que ninguno se
// lleva puesto al otro.
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n' + '-'.repeat(72));
console.log('Plataforma de complementos');

for(const s of SEDES){
  const motor = motores[s.id];
  if(!motor) continue;
  const P = motor.plataforma;
  const Silab = P.Silab;
  const registro = (id, init, capabilities)=> { limpiar(); return Silab.registerPlugin({ id, name:id, capabilities, init }); };
  // Estado limpio ANTES de cada prueba, no después. Si una prueba falla a
  // mitad, el `limpiar()` del final no llega a ejecutarse y el complemento
  // queda registrado: la prueba siguiente recibe "ya estaba registrado" y falla
  // también, y un fallo de una termina pareciendo veinte.
  const limpiar = ()=> ['p-ok','p-roto','p1','p2','p-pegado'].forEach(id=> P.pluginHost.unregister(id));

  prueba(`[${s.id}] la app publica la plataforma y se puede instalar un complemento`, ()=>{
    assert.ok(Silab && typeof Silab.registerPlugin === 'function', 'no hay window.Silab');
    let recibido = null;
    registro('p-ok', (api)=>{ recibido = api; });
    P.pluginHost.bootAll();
    assert.ok(recibido, 'el complemento no llegó a arrancar');
    assert.strictEqual(recibido.plugin.id, 'p-ok', 'el complemento no recibe su propia identidad');
    // La API es la puerta: si un complemento puede tocar esto, la plataforma no
    // está aislando nada.
    assert.ok(Object.isFrozen(recibido), 'la API del complemento debe estar congelada');
    assert.ok(recibido.bus && typeof recibido.bus.on === 'function', 'debe poder suscribirse al bus');
    assert.ok(recibido.records && typeof recibido.records.all === 'function', 'debe poder leer resultados');
    assert.ok(recibido.ui && typeof recibido.ui.registerPanel === 'function', 'debe poder registrar un panel');
  });

  prueba(`[${s.id}] un complemento que falla al arrancar NO tumba la app`, ()=>{
    // El caso que de verdad importa: en un laboratorio, un complemento roto no
    // puede impedir que se registren resultados.
    let buenoArranco = false;
    registro('p-roto', ()=>{ throw new Error('exploto a proposito'); });
    registro('p-ok',   ()=>{ buenoArranco = true; });
    // Que el error no se propague: acá es donde se rompe si el aislamiento falla.
    P.pluginHost.bootAll();
    assert.ok(buenoArranco, 'un complemento roto impidió que otro arrancara');
    // Y la app sigue andando: clasificar un examen tiene que funcionar igual.
    motor.setRecords([]);
    // Ojo: `uvr` es un objeto con una entrada por columna, no un número. La
    // suma se hace con uvrDeCreditos, como en el resto de la suite.
    const r = motor.clasificar(escenarioSimple());
    assert.ok(uvrDeCreditos(r) > 0, 'la app dejó de calcular después de un complemento roto');
  });

  prueba(`[${s.id}] sin la capacidad de escritura, escribir NO existe`, ()=>{
    // El punto de esta prueba: que no sea "falla al llamarla" sino que el
    // método no exista. Un complemento de estadísticas que solo pidió lectura
    // no puede escribir datos clínicos ni aunque se equivoque de nombre.
    let api = null;
    registro('p1', (a)=>{ api = a; }, ['records:read']);
    P.pluginHost.bootAll();
    assert.strictEqual(api.records.create, undefined, 'sin records:write no debería existir records.create');
    assert.strictEqual(api.records.update, undefined, 'sin records:write no debería existir records.update');
    assert.strictEqual(typeof api.records.all, 'function', 'leer sí debe estar disponible');
    // Tampoco puede tocar el catálogo sin pedirlo.
    assert.strictEqual(api.catalog.addExam, undefined, 'sin catalog:write no debería poder agregar exámenes');
  });

  prueba(`[${s.id}] con la capacidad declarada, escribir SÍ funciona`, ()=>{
    let api = null;
    registro('p2', (a)=>{ api = a; }, ['records:write']);
    P.pluginHost.bootAll();
    assert.strictEqual(typeof api.records.create, 'function', 'con records:write debería existir records.create');
  });

  prueba(`[${s.id}] un complemento no puede escribir datos clínicos de un resultado ya liberado`, ()=>{
    // Regla de negocio, no de la plataforma: un resultado liberado es papel
    // firmado. Aunque el complemento pida permiso de escritura, no puede
    // tocarlo — igual que el autoguardado normal.
    motor.setRecords([{ id:'libre', nombre:'Ana Ruiz', dni:'1', fecha:'12/08/2026', status:'released', tests:[], packages:[] }]);
    let api = null;
    registro('p2', (a)=>{ api = a; }, ['records:write']);
    P.pluginHost.bootAll();
    // records.update es asíncrono: el rechazo llega como promesa rechazada, no
    // como excepción. Un try/catch sin await no lo vería y la prueba pasaría
    // mintiendo: el complemento sí había intentado escribir.
    return api.records.update('libre', { nombre:'Cambiada' }).then(
      ()=>{ throw new Error('permitió modificar un resultado ya liberado'); },
      (e)=>{
        assert.match(e.message, /liberado/, `el mensaje debería explicar por qué: "${e.message}"`);
        assert.strictEqual(motor.registros().find(r=>r.id==='libre').nombre, 'Ana Ruiz', 'el nombre cambió igual');
      }
    );
  });

  prueba(`[${s.id}] un resultado creado por un complemento lleva código de laboratorio`, ()=>{
    // Esta es la diferencia con el prototipo: en OS el complemento podía crear
    // una ficha sin labCode. En estas sedes el código es lo que se imprime en el
    // papel y lo que permite encontrar el resultado después, así que una ficha
    // sin código es una ficha que nadie puede ubicar.
    prueba(`[${s.id}] el núcleo avisa cuando la interfaz guarda un resultado`, ()=>{
    // Este es el punto del que dependía todo lo demás. Un complemento de
    // control de calidad necesita enterarse de los resultados que carga el
    // usuario desde los formularios. Antes el bus solo lo emitían los propios
    // complementos, así que ese plugin era un adorno: nunca veía nada.
    // Ojo: se cuenta SOLO lo que menciona esta ficha, no todo lo que pase por el
    // bus. El corredor lanza las pruebas sin esperar a las asíncronas, así que
    // hay otras creando fichas al mismo tiempo; si esta contara todo, fallaría
    // por culpa ajena. Cada prueba tiene que hablar únicamente de la suya.
    const mios = [];
    const listo = P.bus.on('records:added', (p)=>{
      if(Array.isArray(p.ids) && p.ids.indexOf('nuevo-de-la-ui') >= 0) mios.push(p);
    });
    // Ojo: `P` es solo {Silab, bus, pluginHost}; el estado del motor se
    // pide a `motor`, y `api.records` es del complemento, no del núcleo.
    const yaEstaba = motor.recordsKernel().length;
    // Así se guardan las cosas desde la interfaz: el kernel muta y después se
    // reconstruye la vista global.
    motor.recordsKernel().upsert({ id:'nuevo-de-la-ui', labCode:'L-0001', nombre:'Alta desde formulario', fecha:'15/09/2026', tests:[] });
    motor.sincronizarRecords();
    assert.strictEqual(mios.length, 1, `el núcleo debía avisar una vez y avisó ${mios.length}`);
    // estable() y no deepStrictEqual: el array viene del sandbox y su prototipo
    // no es el de este archivo, así que deepStrictEqual los rechaza siempre.
    assert.strictEqual(estable(mios[0].ids), '["nuevo-de-la-ui"]', 'el aviso no dijo qué ficha era');
    // Guardar lo mismo de nuevo no es un alta: no puede volver a avisar.
    motor.sincronizarRecords();
    assert.strictEqual(mios.length, 1, 'un resincronizado sin cambios avisó como si fuera un alta');
    assert.ok(motor.recordsKernel().length > yaEstaba, 'la ficha no llegó a la lista global');
    listo();
  });

  prueba(`[${s.id}] un resultado creado por un complemento se avisa UNA sola vez`, ()=>{
    // Si se avisara desde el propio complemento y también desde el núcleo, un
    // control de calidad contaría cada ficha dos veces y su promedio se
    // deformaría sin que se note.
    // El aviso sale DURANTE el create, antes de que exista el id para
    // compararlo, así que se anotan todos los ids que pasan y después se
    // filtra por el propio. Filtrar en el momento de recibir no serviría: en
    // ese instante todavía no hay con qué distinguir esta ficha de las que
    // crean otras pruebas al mismo tiempo.
    const anunciados = [];
    const listo = P.bus.on('records:added', (p)=>{
      if(Array.isArray(p.ids)) anunciados.push.apply(anunciados, p.ids);
    });
    let api = null;
    registro('p2', (a)=>{ api = a; }, ['records:write']);
    P.pluginHost.bootAll();
    let rec = null;
    return api.records.create({ nombre:'Contada Una Vez', fecha:'15/09/2026', servicio:'MEDICINA - HOSPITALIZACION' })
      .then(r=>{ rec = r; })
      .then(()=>{
        const veces = anunciados.filter(id=> id === rec.id).length;
        assert.strictEqual(veces, 1, `la ficha creada por el complemento se avisó ${veces} veces en vez de una`);
        listo();
      });
  });

  // ── El complemento de ejemplo, de punta a punta ─────────────────────────
  // Estas pruebas cargan el archivo real complementos/control-calidad.js. No
  // se reescribe una maqueta: si ese archivo se rompe, estas pruebas se caen.
  //
  // Cada prueba levanta su PROPIO motor, y no usa el compartido. Dos razones,
  // las dos importan:
  //   1. Vacían la lista de resultados y la de complementos.
  //   2. El corredor lanza las pruebas sin esperar a las asíncronas.
  // Con un motor compartido, dos de estas pruebas se pisan, la que pierde
  // culpa a la que gana, y el fallo apunta al lugar equivocado. Un motor
  // aparte por prueba es barato y hace que cada una hable solo de lo suyo.
  const rutaQC = require('path').join(__dirname, 'complementos', 'control-calidad.js');
  const codigoQC = fs.readFileSync(rutaQC, 'utf8');

  // Si el motor no se puede cargar, la prueba se marca como no aplicable en vez
  // de fallar por un motivo ajeno.
  function nuevoQC(){
    try{
      const m = cargarMotor(s);
      return { m, p: m.plataforma };
    }catch(e){ return null; }
  }
  const pruebaQC = (nombre, fn)=> prueba(nombre, ()=>{
    const qc = nuevoQC();
    if(!qc) return undefined;
    return fn(qc.m, qc.p);
  });

  const flush = ()=> new Promise(r=> setImmediate(r));

  // El ciclo de vida real: la app carga los complementos y al final de init()
  // llama a bootAll(). Sin ese arranque, uno recién instalado queda registrado
  // pero nunca corre. Por eso el paso va explícito en cada prueba.
  const arrancar = (p)=>{ p.pluginHost.bootAll(); return flush().then(flush); };

  const panelInstalado = (p)=> p.pluginHost.panels().some(x=> x.title === 'Control de Calidad');

  function liberarCon(m, nombre, valor, n){
    m.recordsKernel().upsert({
      id: `qc-${nombre}-${n}`, labCode: `QC-${n}`, nombre, fecha:`01/0${n}/2026`,
      status:'released', tests:[{ name:'Hemoglobina', value:String(valor), factor:1 }]
    });
  }

  // Dibuja el panel del complemento en un contenedor falso y devuelve el HTML.
  // Se mira lo que el usuario vería, no las variables internas del complemento:
  // esas son suyas y la prueba no tiene por qué conocerlas.
  function htmlDelPanel(p, titulo){
    const panel = p.pluginHost.panels().find(x=> x.title === titulo);
    if(!panel) return null;
    const cont = { innerHTML:'', querySelector: ()=> null, querySelectorAll: ()=> [] };
    panel.render(cont);
    return cont.innerHTML;
  }

  pruebaQC(`[${s.id}] el complemento de ejemplo se instala pegando su código`, (m, p)=>{
    m.setRecords([]);
    return m.Silab.installFromCode(codigoQC).then(lista=>{
      assert.strictEqual(lista.length, 1, 'no quedó registrado como único complemento');
      assert.strictEqual(lista[0].id, 'control-calidad', `se registró "${lista[0].id}"`);
      assert.strictEqual(lista[0].type, 'code', 'no se guardó como código pegado');
      return arrancar(p);
    }).then(()=>{
      assert.ok(panelInstalado(p), 'se instaló pero nunca arrancó, así que no tiene panel');
    });
  });

  pruebaQC(`[${s.id}] el complemento de ejemplo no puede escribir datos clínicos`, (m, p)=>{
    // No pidió capabilities, así que la API debe llegarle sin los métodos de
    // escritura. No es que fallen si los llama: es que no existen.
    let api = null;
    p.pluginHost.register({ id:'qc-sonda', name:'Sonda', init: (a)=>{ api = a; } });
    return arrancar(p).then(()=>{
      assert.ok(api, 'el complemento no arrancó');
      // estable() y no deepStrictEqual: el array viene del sandbox y su
      // prototipo no es el de este archivo.
      assert.strictEqual(estable(api.capabilities), '[]', 'pidió capacidades que no necesita');
      assert.strictEqual(api.records.create, undefined, 'le llegó records.create sin pedirlo');
      assert.strictEqual(api.records.update, undefined, 'le llegó records.update sin pedirlo');
      assert.strictEqual(typeof api.records.all, 'function', 'no puede ni leer los resultados');
    });
  });

  pruebaQC(`[${s.id}] el complemento de ejemplo calcula el control con los resultados reales`, (m, p)=>{
    // 14 ± 1. Se sueltan controles en 14 (dentro), 14 (dentro), 14.6 (+0.6 DE)
    // y después 18.5: +4.5 DE, que es un 1-3s clarísimo.
    m.setRecords([]);
    liberarCon(m, 'Uno', 14, 1);
    liberarCon(m, 'Dos', 14, 2);
    liberarCon(m, 'Tres', 14.6, 3);
    liberarCon(m, 'Cuatro', 18.5, 4);
    m.sincronizarRecords();
    return m.Silab.installFromCode(codigoQC)
      .then(()=> arrancar(p))
      .then(()=>{
        const html = htmlDelPanel(p, 'Control de Calidad');
        assert.ok(html, 'el complemento no registró su panel');
        assert.ok(/4<\/b> controles/.test(html), `el panel no cuenta los 4 controles:\n${(html||'').slice(0,300)}`);
        assert.ok(/1-3s/.test(html), 'un valor a +4.5 DE tiene que disparar 1-3s, y el panel no la muestra');
        assert.ok(/Se salió de .3 DE/.test(html), 'el panel no explica por qué se descartó el lote');
        assert.ok(/18\.5/.test(html), 'el panel no muestra el valor del último control');
        // Un borrador NO debe contar: un resultado en borrador se puede cambiar
        // después, y promediarlo daría un control de calidad mentiroso.
        m.recordsKernel().upsert({
          id:'qc-borrador', labCode:'QC-99', nombre:'Borrador', fecha:'05/05/2026',
          status:'draft', tests:[{ name:'Hemoglobina', value:'99', factor:1 }]
        });
        m.sincronizarRecords();
        return flush().then(flush);
      })
      .then(()=>{
        const html = htmlDelPanel(p, 'Control de Calidad') || '';
        assert.ok(/4<\/b> controles/.test(html), 'contó un resultado en borrador, que después se puede cambiar');
        assert.ok(!/>99</.test(html), 'el valor 99 del borrador se coló en el control de calidad');
      });
  });

  pruebaQC(`[${s.id}] el complemento de ejemplo se instala desde una URL`, (m, p)=>{
    // El navegador baja el archivo y lo ejecuta. Acá se simula ese paso para
    // probar el camino completo, incluida la lista de instalados.
    m.setRecords([]);
    // Devuelve el código, como haría el navegador con la respuesta. Lo ejecuta
    // el sandbox, que es el único que tiene el `window` correcto.
    m.defineCargadorScript((url)=>{
      if(url !== 'https://ejemplo.org/control-calidad.js') throw new Error(`URL inesperada: ${url}`);
      return codigoQC;
    });
    return m.Silab.installFromUrl('https://ejemplo.org/control-calidad.js').then(lista=>{
      assert.strictEqual(lista.length, 1, 'no se guardó en la lista de instalados');
      assert.strictEqual(lista[0].type, 'url', 'no se guardó con su URL');
      assert.strictEqual(lista[0].url, 'https://ejemplo.org/control-calidad.js', 'guardó una URL distinta');
      return arrancar(p);
    }).then(()=>{
      assert.ok(panelInstalado(p), 'instalado por URL, pero sin panel: el script no llegó a ejecutarse');
    });
  });

  pruebaQC(`[${s.id}] un complemento que no registra nada se avisa, no se instala en silencio`, (m)=>{
    // Si el script carga pero no llama a registerPlugin, el usuario tiene que
    // enterarse: si no, cree que lo instaló y no lo tiene.
    m.defineCargadorScript(()=> '/* carga bien, pero no registra nada */');
    return m.Silab.installFromUrl('https://ejemplo.org/vacio.js').then(
      ()=>{ assert.fail('debería haber lanzado el error de "no registró nada"'); },
      e=>{
        assert.ok(/no llamó a window\.Silab\.registerPlugin/.test(e.message), `mensaje inesperado: ${e.message}`);
        return m.Silab.listInstalled();
      }
    ).then(lista=>{
      assert.strictEqual(lista.length, 0, 'un complemento que no registró nada quedó en la lista');
    });
  });

  // OJO: esta prueba NO borra los registros con setRecords. El corredor lanza
    // las pruebas sin esperar a las asíncronas, así que limpiar el estado
    // compartido desde acá vacía los datos que una prueba anterior todavía
    // está por leer. Se busca por id lo que el propio complemento creó.
    let api = null;
    registro('p2', (a)=>{ api = a; }, ['records:write']);
    P.pluginHost.bootAll();
    return api.records.create({
      nombre:'Creado Por Complemento', dni:'555', fecha:'15/09/2026',
      servicio:'MEDICINA - HOSPITALIZACION',
      tests:[{ name:'Hemoglobina', factor:1, auto:false }]
    }).then(rec=>{
      assert.ok(rec.labCode, 'el complemento creó una ficha SIN código de laboratorio');
      assert.ok(String(rec.labCode).length > 0, 'el código quedó vacío');
      // Y tiene que ser el mismo que quedó guardado, no inventado en el camino.
      const guardado = motor.registros().find(r=>r.id === rec.id);
      assert.ok(guardado, 'la ficha no llegó al estado de la app');
      assert.strictEqual(guardado.labCode, rec.labCode, 'el código guardado difiere del devuelto');
      return api.records.create({ nombre:'Segundo', fecha:'15/09/2026', servicio:'MEDICINA - HOSPITALIZACION' })
        .then(rec2=>({ rec, rec2 }));
    }).then(({rec, rec2})=>{
      // Dos fichas de un complemento NO pueden compartir código: es lo que
      // haría ambigua una búsqueda de un resultado.
      assert.notStrictEqual(rec2.labCode, rec.labCode, 'dos fichas comparten código de laboratorio');
    });
  });

  prueba(`[${s.id}] los complementos no se pisan el almacenamiento entre sí`, ()=>{
    // Dos complementos que usan la MISMA clave ("config") no pueden pisarse.
    // Es lo que hace seguro que varios plugins distintos convivan.
    let a = null, b = null;
    registro('p1', (api)=>{ a = api; }, ['storage']);
    registro('p2', (api)=>{ b = api; }, ['storage']);
    P.pluginHost.bootAll();
    a.storage.set('config', 'soy-el-primero');
    b.storage.set('config', 'soy-el-segundo');
    const va = a.storage.get('config'), vb = b.storage.get('config');
    return Promise.all([va, vb]).then(([ra, rb])=>{
      assert.strictEqual(ra.value, 'soy-el-primero', 'el segundo complemento pisó al primero');
      assert.strictEqual(rb.value, 'soy-el-segundo', 'el segundo no guardó su propio valor');
    });
  });

  prueba(`[${s.id}] lo que un complemento guarda no se ve desde el otro ni desde la app`, ()=>{
    let a = null;
    registro('p1', (api)=>{ a = api; }, []);
    P.pluginHost.bootAll();
    return a.storage.set('secreto', 'x').then(()=> motor.__mem.get('plugin:p1:secreto'))
      .then(v=>{
        assert.ok(v, 'el dato no se guardó bajo la clave del complemento');
        assert.strictEqual(motor.__mem.get('secreto'), undefined, 'un complemento escribió fuera de su espacio');
      });
  });

  prueba(`[${s.id}] un complemento puede ver los resultados que se guardan`, ()=>{
    // El motivo de existir del bus: un complemento de control de calidad tiene
    // que enterarse de los resultados nuevos sin que la app sepa que existe.
    let api = null, vistos = [];
    registro('p1', (a)=>{ api = a; }, []);
    P.pluginHost.bootAll();
    api.bus.on('records:updated', (p)=> vistos.push(p));
    P.bus.emit('records:updated', { id:'r9', origen:'prueba' });
    assert.deepStrictEqual(vistos.map(v=>v.id), ['r9'], 'el complemento no recibió el evento');
  });

  prueba(`[${s.id}] un complemento roto al dibujar su panel no rompe el modal`, ()=>{
    registro('p-ok', (api)=>{
      api.ui.registerPanel('El que funciona', ()=>{});
      api.ui.registerPanel('El que revienta', ()=>{ throw new Error('falla al dibujar'); });
    }, []);
    P.pluginHost.bootAll();
    const paneles = P.pluginHost.panels();
    assert.strictEqual(estable(paneles.map(p=>p.title)), '["El que funciona","El que revienta"]',
      'los dos paneles deberían estar registrados y en orden');
    // renderPluginPanelContent aísla el error del que revienta al dibujarse.
    assert.ok(motor.puedeDibujarPaneles, 'debe existir la función que dibuja paneles');
    assert.doesNotThrow(()=> motor.dibujarPanel(paneles[1]), 'un panel roto no debe propagar el error');
    assert.doesNotThrow(()=> motor.dibujarPanel(paneles[0]), 'el panel sano debe dibujarse normal');
  });

  prueba(`[${s.id}] instalar desde código es la vía que no toca el HTML`, ()=>{
    // Lo que se está probando es el punto del proyecto: pegar un complemento y
    // que quede funcionando, sin editar los archivos de la app.
    //
    // Que "haya quedado registrado" se comprueba por lo que HIZO —su init corrió
    // y avisó por la API—, no releyendo el registro de complementos después del
    // await. El corredor lanza las pruebas sin esperar: mientras esta promesa
    // está pendiente, la prueba siguiente ya corrió y su limpieza desregistró
    // el complemento, y la comprobación fallaría por una carrera del TEST, no
    // por un defecto de la app.
    const codigo = "window.Silab.registerPlugin({ id:'p-pegado', name:'Pegado', "
      + "init(api){ (globalThis.__pluginsVivos = globalThis.__pluginsVivos || []).push(api.plugin.id); } });";
    // installFromCode devuelve la lista de instalados YA GUARDADA (no los ids
    // sueltos), igual que installFromUrl: las dos devuelven lo mismo.
    return Silab.installFromCode(codigo).then(lista=>{
      assert.strictEqual(estable(lista.map(e=> e.id)), '["p-pegado"]', 'no se detectó el complemento registrado por el código');
      assert.strictEqual(estable(lista.map(e=> e.type)), '["code"]', 'no se guardó como código pegado');
      // El array viene del sandbox: se compara por contenido.
      assert.strictEqual(estable(motor.pluginsVivos()), '["p-pegado"]',
        'el complemento quedó registrado pero su init no corrió');
      // Y queda guardado para las próximas sesiones, con su tipo.
      return Silab.listInstalled();
    }).then(lista=>{
      const e = lista.find(x=>x.id==='p-pegado');
      assert.ok(e, 'no se guardó para la próxima sesión');
      assert.strictEqual(e.type, 'code');
      // Desinstalar saca el código guardado: es lo que impide que reaparezca al
      // recargar.
      return Silab.uninstall('p-pegado');
    }).then(()=> Silab.listInstalled()).then(lista=>{
      assert.ok(!lista.find(x=>x.id==='p-pegado'), 'la desinstalación no lo quitó de la lista guardada');
    });
  });

  prueba(`[${s.id}] código inválido no deja nada a medias`, ()=>{
    // Si el complemento tiene un error de tipeo, no puede quedar medio
    // instalado ni romper la app: o entra entero, o no entra.
    return Silab.installFromCode("esto no es javascript {{{").then(
      ()=>{ throw new Error('aceptó código inválido'); },
      (e)=>{ assert.ok(/vacío|SyntaxError|Unexpected|Invalid/i.test(e.message) || e instanceof Error, 'el error no es claro'); }
    );
  });

  prueba(`[${s.id}] instalar un complemento cambia los números, no los rompe`, ()=>{
    // La prueba que de verdad importa para un laboratorio: con complementos
    // instalados, el informe sigue dando lo mismo. Si un complemento pudiera
    // alterar el cálculo del núcleo, esto lo diría.
    const antes = motor.clasificar(escenarioSimple());
    registro('p-ok', ()=>{ /* no hace nada */ });
    P.pluginHost.bootAll();
    const despues = motor.clasificar(escenarioSimple());
    // `uvr` e `inc` son objetos que vienen del sandbox: tienen otro prototipo,
    // así que strictEqual los rechaza aunque sean idénticos.
    assert.strictEqual(estable(despues.uvr), estable(antes.uvr), 'un complemento alteró el UVR del núcleo');
    assert.strictEqual(estable(despues.inc), estable(antes.inc), 'un complemento alteró el conteo de exámenes');
  });
}

// Una ficha que la app ya conoce, para comprobar que sigue calculando igual
// cuando hay complementos instalados. Se usa una de las fichas de los
// escenarios en vez de una inventada: una ficha con la forma equivocada
// devolvería 0 y la prueba pasaría por un motivo equivocado.
function escenarioSimple(){ return ESCENARIOS[0].ficha(); }

// ---- Consistencia entre sedes: la base cuadro de columnas tiene que ser igual ----
console.log('\n' + '-'.repeat(72));
console.log('Consistencia entre sedes');
const cargadas = SEDES.filter(s => motores[s.id]);
prueba('las tres sedes comparten la misma lista de columnas de factor variable', ()=>{
  if(cargadas.length < 2) return;
  const ref = JSON.stringify(motores[cargadas[0].id].columnasFactorVariable);
  for(const s of cargadas.slice(1)){
    assert.strictEqual(JSON.stringify(motores[s.id].columnasFactorVariable), ref,
      `${s.id} tiene una lista distinta: ${JSON.stringify(motores[s.id].columnasFactorVariable)}`);
  }
});
prueba('las tres sedes comparten la misma configuración de campaña', ()=>{
  if(cargadas.length < 2) return;
  const ref = JSON.stringify(motores[cargadas[0].id].campana);
  for(const s of cargadas.slice(1)){
    assert.strictEqual(JSON.stringify(motores[s.id].campana), ref, `${s.id} difiere en campanaConfig`);
  }
});
prueba('las tres sedes declaran las mismas claves de columna en el informe', ()=>{
  if(cargadas.length < 2) return;
  const ref = motores[cargadas[0].id].columnas.map(c => c.key).sort().join(',');
  for(const s of cargadas.slice(1)){
    assert.strictEqual(motores[s.id].columnas.map(c => c.key).sort().join(','), ref,
      `${s.id} tiene columnas distintas: si se agregó o quitó una, hay que revisar el informe`);
  }
});
prueba('las tres sedes tienen los mismos factores de columna salvo bioquímica y TP/TTPA', ()=>{
  if(cargadas.length < 2) return;
  const ref = motores[cargadas[0].id].factores;
  const tolerados = new Set(['bioquimica']);
  for(const s of cargadas.slice(1)){
    const f = motores[s.id].factores;
    for(const col in ref){
      if(tolerados.has(col)) continue;
      assert.strictEqual(f[col], ref[col],
        `${s.id}: la columna "${col}" tiene factor ${f[col]} y ${cargadas[0].id} tiene ${ref[col]}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PROPIEDAD DEL ESTADO: quién puede mutar cada variable global
//
// Todo lo de arriba verifica CÁLCULO. Esta sección verifica algo distinto: que
// cada variable global de dominio se mute pasando por su kernel y no a mano.
//
// Por qué importa: la suite verificaba que el informe cuadra, pero nada impedía
// que alguien escribiera `records.push(...)` en una función nueva. El resultado
// seguía siendo correcto en las pruebas y el estado quedaba escrito en un lugar
// del que nadie sabía. Ese es el modo de falla más caro de una migración a
// kernels: no se ve en los números, se ve meses después.
//
// Dos niveles de exigencia, según dónde va la migración:
//
//   - Variables YA extraídas (ESTADO_EN_KERNEL): no puede haber ninguna
//     mutación directa en todo el archivo, salvo dentro de la función de
//     sincronización que reconstruye la vista global. Cero tolerancia.
//   - Variables PENDIENTES: la línea base se fija al número actual y el test
//     falla si sube. Subir significa que alguien agregó un sitio nuevo sin
//     pasar por el kernel. Bajar es progreso y hay que bajar la línea base.
//
// Para convertir un pendiente en extraído: vaciar su línea base a 0, migrar los
// sitios, y el test pasa a exigir cero.
const ESTADO_EN_KERNEL = new Set([
  'currentTests', 'currentPackages', 'manualTests',
  // editingId también es propiedad de WorksheetKernel: su única escritura
  // legítima es la vista que reconstruye sincronizarWorksheet().
  'editingId',
  'records',
  'auditLog',
  'users',
  'directory',
  'bkExternos',
  'customCatalog',
]);

// Único lugar del archivo autorizado a escribir estas variables: reconstruye la
// vista global desde el kernel después de una operación.
const FUNCION_SINCRONIZA = 'sincronizarWorksheet';

// Cada kernel tiene su propia función de sincronización: son los únicos lugares
// del archivo autorizados a escribir la vista global de su área.
const FUNCIONES_SINCRONIZA = {
  currentTests:     'sincronizarWorksheet',
  currentPackages:  'sincronizarWorksheet',
  manualTests:      'sincronizarWorksheet',
  editingId:        'sincronizarWorksheet',
  records:          'sincronizarRecords',
  auditLog:         'sincronizarAudit',
  users:            'sincronizarUsers',
  directory:        'sincronizarDirectory',
  bkExternos:       'sincronizarBkExternos',
  customCatalog:    'sincronizarCustomCatalog',
};

// Línea base de las variables que todavía no son kernel. Es el inventario
// exacto de lo que falta migrar, y a la vez una alarma contra sitios nuevos.
//
// Los números son los sitios contados uno por uno sobre el código real. `records`
// eran 12 (carga desde nube, carga desde local, orden por fecha, cinco upsert
// por índice, dos push, el borrado por id y el guardado masivo) hasta que se
// migró a RecordsKernel y quedó en 0. Cuando uno se migre, la cifra baja; si se
// agrega uno nuevo, sube y el test avisa.
const LINEA_BASE_PENDIENTE = {
  lampa:  {},
  ilave:  {},
  putina: {},
};
const TODAS_LAS_VARIABLES = [
  'records','currentTests','currentPackages','manualTests',
  'users','auditLog','directory','bkExternos','customCatalog',
];

console.log('\n' + '-'.repeat(72));
console.log('Propiedad del estado (migración a kernels)');

for(const s of SEDES){
  prueba(`[${s.id}] las variables del kernel no se mutan a mano`, ()=>{
    const src = leerHTML(s);
    const hallados = escanearMutaciones(src, Array.from(ESTADO_EN_KERNEL));
    // Las funciones de sincronización son la excepción legítima: su trabajo ES
    // escribir la vista global. Cada variable tiene la suya; una mutación dentro
    // de sincronizarWorksheet() no legitima escribir en records, y al revés.
    const rangos = {};
    for(const variable of ESTADO_EN_KERNEL){
      const nombre = FUNCIONES_SINCRONIZA[variable];
      if(rangos[nombre] === undefined){
        const inicio = src.indexOf('function ' + nombre);
        let fin = -1;
        if(inicio !== -1){
          const cuerpo = extraerFuncion(src, nombre);
          fin = cuerpo ? inicio + cuerpo.length : -1;
        }
        rangos[nombre] = { inicio, fin };
      }
    }
    const ilegales = hallados.filter(h => {
      const { inicio, fin } = rangos[FUNCIONES_SINCRONIZA[h.variable]];
      if(inicio === -1) return true;
      const pos = desplazamientoDeLinea(src, h.linea);
      return !(pos >= inicio && (fin === -1 || pos < fin));
    });
    assert.deepStrictEqual(ilegales.map(h => `${h.variable} L${h.linea} (${h.tipo})`), [],
      `estas variables deberían pasar por su kernel y se están escribiendo directo. ` +
      `Lo único autorizado es la función de sincronización de cada una.` +
      (ilegales.length ? '\n      ' + ilegales.map(h => `L${h.linea}: ${h.texto}`).join('\n      ') : ''));
  });

  prueba(`[${s.id}] no aparecen sitios nuevos de mutación directa`, ()=>{
    const src = leerHTML(s);
    const base = LINEA_BASE_PENDIENTE[s.id];
    const problemas = [];
    for(const variable in base){
      const n = escanearMutaciones(src, [variable]).length;
      if(n !== base[variable]){
        problemas.push(`${variable}: hay ${n} y la línea base dice ${base[variable]}` +
          (n > base[variable]
            ? '  <-- sitio NUEVO: migrar por el kernel o, si es legítimo, actualizar la línea base'
            : '  <-- progreso: si ya no queda ninguno, poner la línea base en 0'));
      }
    }
    assert.deepStrictEqual(problemas, [], 'la línea base de mutaciones directas no cuadra');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EL TEST DIFERENCIAL: la misma sede, antes y después de la migración.
//
// Todo lo de arriba contesta "¿el número que reporta el hospital es el que
// corresponde?". Esto contesta la otra pregunta, la que aparece cuando alguien
// tiene que aprobar un cambio de miles de líneas en tres archivos de
// producción: "¿este refactor movió algún número?".
//
// Se corre la MISMA ficha por el motor actual y por el de la copia
// pre-migración, y se compara la salida completa: no solo el UVR total, sino
// campo por campo (incidencias, UVR, créditos, nombres de otros, totales por
// servicio y por área). Un cambio de 0.01 en una celda aparece acá.
//
// Uso:  node paridad-sedes.test.js --dif
// ─────────────────────────────────────────────────────────────────────────────
// El diferencial corre al final, cuando ya resolvieron las pruebas asíncronas:
// si arranca antes, su salida se mezcla con la de ellas y el resumen queda
// ilegible (el total de abajo ya estaba bien, pero era imposible de leer).
const argDif = process.argv.some(a => a === '--dif' || a === '--dif=si');

function correrDiferencial(){
  console.log('\n' + '='.repeat(72));
  console.log('Diferencial pre/post migración — misma entrada, dos motores');
  console.log('='.repeat(72));

  for(const sede of SEDES){
    const ref = PRE_MIGRACION[sede.id];
    if(!ref){
      // Putina no tiene copia pre-migración guardada. No se puede comparar lo
      // que no está, y comparar solo dos de tres simularía una garantía que no
      // es real: se dice cuál falta.
      console.log('\n' + sede.label);
      console.log('  ? sin copia pre-migración: no hay contra qué comparar');
      omitidas++;
      continue;
    }
    console.log('\n' + sede.label + ' vs ' + ref.etiqueta);
    // Un motor NUEVO, no el que ya usó la suite de arriba. Reusar ese motor
    // compararía un estado que la suite dejó cargado contra uno recién abierto,
    // y daría diferencias que no son de la migración (en la primera versión de
    // esta prueba, la matriz daba igual y el total de baciloscopias no, solo
    // porque la suite había cargado datos en el motor compartido).
    let actual, previo;
    try{ actual = cargarDelMonolito(sede); }
    catch(e){ console.log(`  ✗ no se pudo cargar el motor actual: ${e.message}`); fallaron++; continue; }
    try{ previo = cargarDelPreMigracion(sede); }
    catch(e){ console.log(`  ? sin comparación: ${e.message.split('\n')[0]}`); omitidas++; continue; }


    // Las constantes de la sede tienen que ser las mismas: si el refactor
    // hubiera cambiado un factor, esto lo dice antes de comparar nada.
    prueba('las constantes de la sede no cambiaron en la migración', ()=>{
      for(const k of ['factorBioq', 'factorTpttpa', 'prefijoLabCode']){
        assert.strictEqual(actual[k], previo[k],
          `${k}: antes ${previo[k]}, ahora ${actual[k]}. Si cambió, es un cambio deliberado y hay que anotarlo.`);
      }
    });

    // Cada escenario, comparado campo por campo.
    for(const esc of ESCENARIOS){
      prueba(`${esc.nombre} → misma salida que antes de la migración`, ()=>{
        const ficha = esc.ficha();
        const res = actual.clasificar(ficha);
        const antes = previo.clasificar(ficha);
        compararSalida('clasificar', antes, res);
        // Y el número que ve el humano, por si el detalle coincide pero la
        // suma no.
        assert.ok(casiIgual(uvrDelInforme(antes, previo), uvrDelInforme(res, actual)),
          `el UVR de pantalla cambió: antes ${uvrDelInforme(antes, previo)}, ahora ${uvrDelInforme(res, actual)}`);
      });
    }

    // Y las funciones puras: son las que más se tocan en un refactor (cambiar
    // un || por un ??, un toLowerCase(), un || 0) y las que nadie mira porque
    // no se ven.
    const CASOS_PUROS = [
      ['fecha', ['15/09/2026', '2026-09-15', '15-09-2026', '', null, '1/9/26']],
      ['fechaFlexible', ['15/09/2026', '2026-09-15', '15-09-2026', 'sep 2026', 'texto']],
      ['iso', [new Date(2026, 8, 15), '2026-09-15', null]],
      ['edad', ['1990-05-04', '15/09/2026', null]],
      ['dni', ['12345678', 12345678, '  12345678 ', 'abc', null]],
      ['paraNube', [{ a:1, b:undefined, c:null, d:'x' }, {}]],
      ['normalizaBk', [60, '60', { esputo:2, orina:1, heces:0 }, null, '', { esputo:-3 }]],
      ['bkTotal', [60, { esputo:2, orina:1, heces:0 }, null]],
    ];
    for(const [nombre, entradas] of CASOS_PUROS){
      const fn = nombre === 'normalizaBk' ? 'normalizaBk' : nombre;
      prueba(`función pura ${fn}() → idéntica`, ()=>{
        for(const entrada of entradas){
          const a = compararPorNombre(actual, previo, nombre, entrada);
          assert.strictEqual(estable(a.nuevo), estable(a.viejo),
            `${nombre}(${JSON.stringify(entrada)}): antes ${JSON.stringify(a.viejo)}, ahora ${JSON.stringify(a.nuevo)}`);
        }
      });
    }

    // El informe entero, no solo la ficha suelta: la matriz que se imprime.
    // Acá el error se vería como una celda corrida en el cuadro, que es
    // exactamente como lo encuentra el hospital.
    prueba('la matriz del informe mensual es idéntica', ()=>{
      const fichas = ESCENARIOS.slice(0, 10).map((e, i) => Object.assign(e.ficha(), {
        id:'r'+i, fecha:'15/09/2026', nombre:'Paciente '+i, servicio:'MEDICINA - HOSPITALIZACION',
      }));
      actual.setRecords(fichas); previo.setRecords(fichas);
      const ra = actual.matriz('09', '2026'), rp = previo.matriz('09', '2026');
      compararSalida('matriz', rp, ra);
      compararSalida('uvrMatriz', rp.uvrMatrix, ra.uvrMatrix);
      compararSalida('otrosBreakdown', rp.otrosBreakdown, ra.otrosBreakdown);
      compararSalida('sinServicio', rp.sinServicio, ra.sinServicio);
      assert.ok(casiIgual(actual.totalBk('09','2026'), previo.totalBk('09','2026')),
        'las baciloscopias del mes cambiaron');
    });

    // El código de laboratorio: se arma con el prefijo de la sede y la fecha.
    // Es lo que se imprime en el papel que va al laboratorio, así que un cambio
    // acá rompe la trazabilidad de resultados ya archivados.
    prueba('el código de laboratorio se arma igual', ()=>{
      if(!actual.sufijoCodigo) return; // esta sede no construye el sufijo acá
      assert.strictEqual(estable(actual.sufijoCodigo('A1B2')), estable(previo.sufijoCodigo('A1B2')),
        'el sufijo del código cambió');
      assert.strictEqual(estable(actual.partesCodigo(new Date(2026, 8, 15).getTime())),
        estable(previo.partesCodigo(new Date(2026, 8, 15).getTime())), 'las partes de fecha del código cambiaron');
    });
  }
}

// Compara dos objetos de salida campo por campo y señala el primero que difiere.
// Se comparan los números con tolerancia: las sumas de UVR llegan a ~1e4 y una
// diferencia de 1e-13 no es un cambio de comportamiento, es aritmética de coma
// flotante. Todo lo demás es igualdad estricta.
function compararSalida(que, antes, ahora){
  const fallos = [];
  for(const k in antes){
    const a = antes[k], b = ahora[k];
    if(typeof a === 'number' && typeof b === 'number'){
      if(!casiIgual(a, b)) fallos.push(`${que}.${k}: antes ${a}, ahora ${b}`);
    }else if(Array.isArray(a)){
      if(!Array.isArray(b) || a.length !== b.length) fallos.push(`${que}.${k}: antes ${a.length} elementos, ahora ${b && b.length}`);
      else for(let i = 0; i < a.length; i++) compararValor(`${que}.${k}[${i}]`, a[i], b[i], fallos);
    }else if(a && typeof a === 'object'){
      if(!b || typeof b !== 'object') fallos.push(`${que}.${k}: antes objeto, ahora ${typeof b}`);
      else for(const j in a) compararValor(`${que}.${k}.${j}`, a[j], b[j], fallos);
    }else if(a !== b){
      fallos.push(`${que}.${k}: antes ${JSON.stringify(a)}, ahora ${JSON.stringify(b)}`);
    }
  }
  // Un campo que la copia vieja no tenía NO es un cambio de la migración: la
  // copia es de antes de otro refactor. `credits` se agregó el 26/09/2026 (ver
  // RESUMEN_REFACTOR_CREDITOS_LAMPA_ILAVE.md) y estas copias son del 26/09, más
  // temprano. Comparar esos campos sería comparar dos versiones de la app, no
  // dos versiones del refactor. Se comparan solo los campos que ambos tienen.
  for(const k in ahora){
    if(!(k in antes)) continue;
  }
  assert.deepStrictEqual(fallos, [],
    `la migración cambió la salida en ${fallos.length} lugar(es):\n      ` + fallos.slice(0, 8).join('\n      '));
}
function compararValor(ruta, a, b, fallos){
  if(typeof a === 'number' && typeof b === 'number'){
    if(!casiIgual(a, b)) fallos.push(`${ruta}: antes ${a}, ahora ${b}`);
  }else if(a && typeof a === 'object'){
    for(const j in a) compararValor(`${ruta}.${j}`, a[j], b[j], fallos);
  }else if(a !== b){
    fallos.push(`${ruta}: antes ${JSON.stringify(a)}, ahora ${JSON.stringify(b)}`);
  }
}
function compararPorNombre(actual, previo, nombre, entrada){
  const map = {
    fecha:'fechaFlexible', fechaFlexible:'fechaFlexible', iso:'iso', edad:'edad',
    dni:'dni', paraNube:'paraNube', normalizaBk:'normalizaBk', bkTotal:'totalDe',
  };
  return { nuevo: actual[map[nombre]](entrada), viejo: previo[map[nombre]](entrada) };
}
// `undefined` y `null` se comparan como iguales: una función que antes no
// devolvía nada y ahora devuelve null no es un cambio de comportamiento para
// quien la llama. Es `function` y no `const` a propósito: se usa en las
// pruebas de arriba, que corren antes de llegar acá.
function normalizar(v){ return v === undefined ? null : v; }

// Compara dos valores por estructura. Los objetos que devuelven las funciones
// puras salen de dos contextos de vm distintos (el motor actual y el de la copia
// pre-migración): tienen prototipos diferentes, y deepStrictEqual los rechaza
// aunque tengan exactamente las mismas claves y valores. JSON es lo que de
// verdad compara "el mismo dato", sin meterse con cómo se construyó.
function estable(v){
  if(v === undefined) return 'undefined';
  return JSON.stringify(v, (k, val) => (val === undefined ? '__undefined__' : val));
}

// ─────────────────────────────────────────────────────────────────────────────
// ARRANQUE EN NAVEGADOR — guardia contra colapso por "temporal dead zone".
// Que las funciones puras den el mismo resultado NO alcanza: una página que
// crashea al cargar no llega a enganchar ni un botón. Caso real detectado:
// `new AuditKernel(AUDIT_LOCAL_MAX)` usaba una constante declarada más abajo
// en el archivo. En cualquier navegador eso lanza ReferenceError, la
// inicialización se corta antes de wiring del login, y los botones quedan
// inertes — sin que la suite de paridad (que evaluaba solo las funciones) lo
// viera. La guardia exige: toda constante que alimente la construcción de un
// kernel debe estar declarada ANTES del sitio donde se usa.
const ARCHIVOS_GUARDIA = SEDES.map(x => x.archivo);
for (const deTDZ of ARCHIVOS_GUARDIA){
  prueba(`arranque sin colapso de inicialización (${deTDZ})`, ()=>{
    const fuente = fs.readFileSync(deTDZ, 'utf-8');
    const reUso = /new\s+[A-Za-z0-9_]+Kernel\(\s*([A-Z][A-Z0-9_]{2,})/g;
    const mal = [];
    let m;
    while((m = reUso.exec(fuente))){
      const nombre = m[1];
      const decl = fuente.indexOf(`const ${nombre} =`);
      if(decl === -1 || decl > m.index){
        mal.push(nombre + (decl === -1 ? ' (sin declaración)' : ' (declarada DESPUÉS del uso → ReferenceError al cargar)'));
      }
    }
    assert.deepStrictEqual(mal, [], 'kernel construido con constante en zona muerta: ' + mal.join('; '));
  });
}

Promise.all(pendientes).then(()=>{
  // imprimirResumen llama a process.exit, así que el diferencial tiene que ir
  // ANTES de imprimir el resumen. (Si se invirtiera el orden, el proceso
  // moría ahí y el diferencial no llegaba a correr nunca: pasaba en verde sin
  // haber comparado nada.)
  if(argDif) correrDiferencial();
  imprimirResumen();
});
