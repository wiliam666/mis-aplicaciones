# Refactor: una sola fuente de verdad para UVR / productividad

Fecha: 26/09/2026
Archivos modificados:
-  SILAB_01_Lampa_CORREGIDO-2open.html
-  SILAB_01_Ilave_CORREGIDO-1open.html

Referencia canónica usada: SILAB_01_CentroSaludPutina-1open.html (misma
arquitectura ya validada en Putina).

## Qué cambió (4 bloques por archivo)

1. **classifyTestsForReport** ahora devuelve CUATRO estructuras:
   `{ inc, otrosNames, uvr, credits }`.
   - `inc`: conteo ENTERO real de exámenes (nunca el factor).
   - `uvr`: UVR real de las columnas de factor variable
     (cultivo/antibiograma) y extras (toma de muestra, etc.).
   - `credits`: arreglo `{actorId, actorName, factor, label}` que se llena
     en el MISMO punto donde se decide cada factor (add/addUvr).
   - Se agregó encabezado `/* */` explicando la arquitectura.

2. **computeProductivity** ya NO tiene una tabla de factores duplicada
   (`testUvr()` local eliminada). Consume únicamente `credits`:
   - UVR por autor = suma de los factores de sus créditos (sin repartir el
     total de la ficha por proporción de exámenes).
   - Nº de exámenes por autor = se cuenta por EXAMEN REAL de `rec.tests`
     (por `performedById`), igual que antes (el hemograma completo cuenta
     sus componentes, el informe los agrupa en 1 — diferencia preexistente).

3. **Constantes de hemograma** ampliadas (toma las de Putina):
   - NUEVA `HEMOGRAMA_PKG_NAMES` (reconoce el paquete histórico "Hemograma
     Completo" + variantes manual / 5-diff / 3-diff automatizado + nombres
     intermedios).
   - `HEMOGRAMA_COMPONENT_NAMES` ahora incluye "Recuento de hematíes",
     parámetros del equipo automatizado (RDW-CV, RDW-SD, MPV, PDW, PCT,
     P-LCC, P-LCR) y el diferencial del equipo (Neutrófilos, MID,
     Granulocitos). Se portó también la corrección de "Tiempo de Trombina"
     y "Recuento de hematíes".

4. **colFactor (accesor de factor por columna)** nuevo a nivel de módulo,
   lee el factor de `REPORT_COLUMNS` (única fuente verdad para los literales
   de factor por sede):

### Diferencias de factor entre Ilave y Lampa (mantenidas a propósito)
| Columna / grupo      | Ilave | Lampa | Por qué |
|----------------------|-------|-------|---------|
| `bioquimica`         | 3     | 1     | Ilave = Bioquímica manual; Lampa/Putina = automatizada |
| `OTROS_FACTOR_TP_TTPA` | 6   | 2     | Ilave = TP/TTPA manual; Lampa = semiautomatizado |

El resto del cuadro base (26 columnas) y los factores MINSA son idénticos
en las tres sedes. `classifyTestsForReport` produce el mismo UVR en las
tres (el único sitio que depende de la sede es el factor de `bioquimica`
vía `colFactor('bioquimica')` que se resuelve según la sede y
`OTROS_FACTOR_TP_TTPA`).

## Reglas estrictas garantizadas por el diseño
- `inc` siempre entero (1 por examen real; cultivo 1 incluso si su UVR es 24).
- Multiplicador de campaña se aplica ÚNICAMENTE a `uvr`/`credits` (nunca al
  conteo `inc`), vía `aplicarAjusteCampana` + bloque de crédito de campaña
  ("Fase preanalítica masiva").
- NO se factura antibiograma si el cultivo es Negativo (regla
  `t.fields.resultado === 'Positivo'`).
- GeneXpert NO se cuenta como casillero de BK (no se tocó).
- Reparto de hemograma (12) y Widal (16) SOLO entre los autores de los
  componentes realmente cargados en esa ficha (proporcional a componentes),
  nunca mezclado con orina/bioquímica/otros de la misma ficha.

## Comportamientos documentados
- **rinflam (CORREGIDO 26/09/2026)**: la reacción inflamatoria en heces que
  acompaña a cada muestra del Parasitológico Seriado / Examen Directo de
  Heces se cuenta en la columna fija R.INFLAM (matriz × 5) del Informe
  Mensual y ahora TAMBIÉN se acredita al autor del parasitológico
  (`creditT(veces*5, 'Reacción inflamatoria (seriado)')`). Con esto la
  paridad Productividad == Informe es EXACTA en UVR (la única fuente de
  diferencia era esa línea). La R.INFLAM aislada ("Reacción inflamatoria en
  heces" sola) ya se acreditaba (factor 5).
- **Sedimento junto a orina completa**: el sedimento urinario se factura
  siempre con el examen completo de orina (5 + 3) y el crédito de ambos va
  al autor del examen de orina; un "Sedimento urinario" suelto en la misma
  ficha NO se vuelve a acreditar.
- **Widal suelto sin paquete**: cada antígeno suelto cuenta como 1 examen
  (`inc.widal` suma 1 por antígeno) y aporta UVR 4 al autor de ese antígeno.
- **Toma de muestra sanguínea (5)**: se acredita al CREADOR de la ficha
  (quien registró = quien tomó la muestra), 1 sola vez por ficha con sangre.

## Validación (simulación funcional — 12/12 casos OK)
Ejecutada sobre el código REAL extraído de los dos archivos modificados
(scenarios: hemograma 1 autor; Widal paquete; Widal sueltos multi-autor;
orina+sedimento; cultivo positivo con antibiograma; cultivo negativo sin
antibiograma; parasitológico seriado + skew rinflam; TP/Sullivan con factor
de sede; mezcla de un mes completo con paridad global por autor; campaña
multiplicador× 2 con `inc` intacto).

En todos los casos: `Informe == Productividad` (suma de créditos) en UVR —
ahora con paridad EXACTA del total (incluida la columna R.INFLAM) —, `inc`
entero, y las columnas de factor variable no se multiplican en el informe.
Verificación agregada de un mes de prueba: informe 215 UVR == productividad
215 UVR (dif 0). Con esto queda resuelta la diferencia UVR reportada en
setiembre (informe 8950 vs productividad 8860, +90 = 6 fichas de
Parasitológico Seriado × rinflam 15 c/u). La diferencia restante entre ambos
reportes es solo de CONTEO de exámenes (productividad cuenta líneas,
informe agrupa/absorbe) y es por diseño (ver ANALISIS_DIFERENCIA_3078_vs_2344.md).

## Entregables generados
- DIFF_LAMPA_creditos.txt, DIFF_ILAVE_creditos.txt (diff del archivo
  completo antes/después).
- Resumen: este archivo.
- Backups de origen: /tmp/opencode/Lampa_orig.html, /tmp/opencode/Ilave_orig.html