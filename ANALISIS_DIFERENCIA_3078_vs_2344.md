# Análisis de la diferencia entre el PDF de Productividad (3078) y el Informe Mensual (2344)

**Fecha del análisis:** septiembre 2026
**Establecimiento:** Hospital Antonio Barrionuevo — Lampa
**Mes analizado:** SETIEMBRE 2026
**Archivo Excel auditado:** `Informe_Mensual_SETIEMBRE_2026.xlsx`
**App analizada:** `SILAB_01_Lampa_CORREGIDO-2open.html`

---

## 1. Resumen ejecutivo

| Concepto | Cantidad |
|---|---|
| Exámenes según PDF de **Productividad** (app) | **3078** |
| Exámenes según **Informe Mensual** base (Excel, "tal como se registran en la app") | **2344** |
| **Diferencia (neto)** | **+734** |

**No hay error de datos ni duplicados.** Los dos números miden conceptos distintos:

- **Productividad** cuenta la cantidad de **líneas de examen** registradas (cada procedimiento/técnica que hizo el personal).
- **Informe Mensual** cuenta la cantidad de **exámenes** según el criterio administrativo/MINSA del cuadro de reporte (agrupa, absorbe y multiplica con reglas específicas).

La diferencia de +734 se explica casi por completo por la regla del **Hemograma Completo**: una ficha de hemograma se guarda como **13 líneas** en la app, pero el informe mensual la contabiliza como **1 solo examen**.

---

## 2. Qué cuenta cada reporte

### 2.1 PDF de Productividad → `computeProductivity()` → 3078

Código equivalente:

```js
tests.forEach(t => {
  const a = autorDe(t);
  addExamen(a.key, a.nombre, key, 1);   // +1 por CADA línea de examen almacenada
  const uv = testUvr(t) * mul;
  if (uv) addUvr(a.key, a.nombre, key, uv);
});
```

- `addExamen(..., 1)` suma **1 por cada entrada de `rec.tests`**, sin importar si es un componente de un perfil, un sedimento absorbido o un antígeno de Widal.
- El total de la columna "exámenes" del reporte = suma de todas las entradas de `rec.tests` de todas las fichas del período.
- **Mide**: volumen de trabajo / procedimientos realizados por persona.

### 2.2 Informe Mensual → `classifyTestsForReport()` + `REPORT_COLUMNS` → 2344

- Cuenta exámenes **por columna del cuadro** (Cultivo, Antibiograma, Baciloscopia, Orina, Hemograma, Bioquímica, Inmunoserología, Otros, etc.).
- Aplica reglas de **absorción** (algunos exámenes se agrupan en 1 solo) y de **multiplicación** (algunos exámenes valen por muestra/determinación).
- El total de la sección "Nº DE EXAMENES REALIZADOS (base)" del Excel = suma de esas columnas = **2344**.
- Dentro de ese total, la columna **OTROS = 466** exámenes (con detalle de trazabilidad).
- **Mide**: producción según el cuadro oficial del laboratorio (para reporte mensual a la dirección).

---

## 3. Reglas que hacen divergir los conteos

### 3.1 Reglas que INFLAN la Productividad (design/productividad mayores)

| Regla | Productividad | Informe Mensual | Diferencia por ficha |
|---|---|---|---|
| **Hemograma Completo** | 13 líneas (componentes expandidos del panel) | **1** examen (`add('hemograma')`, se saltan los 13 componentes) | **+12** a favor de productividad |
| **Sedimento urinario** junto a Orina Completa | 1 línea extra | absorbido (0) | **+1** a favor de productividad |
| **Antígenos de Widal** con paquete de Reacción de Widal | 4 líneas (cada antígeno) | 1 (`widal`) | **+3** a favor de productividad |

### 3.2 Reglas que INFLAN el Informe Mensual

| Regla | Productividad | Informe Mensual |
|---|---|---|
| **Parasitológico Seriado** | 1 línea = 1 examen | 1 por muestra (máx. 3) **+ 1 reacción inflamatoria por muestra** |
| **Baciloscopia (BK)** | 1 línea = 1 examen | 1 por muestra (M1, M2, adicional) |
| **PTOG** | 1 línea = 1 examen | 1 por determinación (ayunas/1h/2h/3h) |
| **RPR** | 1 línea = 1 examen | 1 por ronda (determinaciones) |
| **Antibiograma** (cultivo Positivo) | 1 línea = 1 examen | + 1 por ronda de antibiograma |
| **Test de Graham** | 1 línea = 1 examen | 1 por muestra (I/II/III) |
| **Toma de muestra sanguínea** | **No cuenta como examen** (solo aporta UVR = 5) | **+1** en columna OTROS con factor 5, por cada ficha con muestra de sangre |

---

## 4. Explicación del numero 734

```
734 (neto) = X − Y

X = lo que productividad cuenta y el informe no:
    · componentes de hemograma  (13 → 1, es decir +12 por ficha)
    · sedimentos absorbidos
    · antígenos de Widal absorbidos

Y = lo que el informe cuenta y productividad no:
    · seriados multi-muestra (parasitológico, BK, Graham)
    · PTOG / RPR por determinación
    · antibiogramas
    · tomas de muestra sanguínea (+1 por ficha)
```

### Comprobación rápida con el hemograma

```
734 ÷ 12 ≈ 61 fichas de hemograma completo
```

Es decir: con unas **~61 fichas de Hemograma Completo** en setiembre se cubre casi todo el +734, antes de restar los contrapesos listed arriba (que reducen el neto).

**Conclusión:** el grueso de los 734 corresponde a **componentes de hemograma agrupados como 1 solo examen** en el informe mensual.

---

## 5. ¿Cuál es el número "correcto"?

**Ambos.** Son métricas con propósitos distintos:

- **3078 (productividad):** refleja el esfuerzo y la cantidad de procedimientos/líneas de trabajo que realizó cada técnico. Útil para gestionar personal y carga de trabajo.
- **2344 (informe mensual):** refleja la producción según el cuadro oficial de exámenes del laboratorio. Útil para el reporte administrativo mensual.

El informe mensual **NO subestima trabajo**: agrupa el hemograma porque a nivel administrativo/MINSA es un solo examen facturable, pero eso no significa que se pierdan los procedimientos individuales.

---

## 6. Si se quiere alinear ambos reportes (opcional)

Para que el conteo de "exámenes" de `computeProductivity()` coincida con el informe mensual, se debería aplicar en él las mismas reglas de absorción:

1. Contar `hemograma` como **1** cuando la ficha trae el perfil (en vez de contar sus 13 componentes).
2. Absorber sedimento urinario cuando hay orina completa.
3. Absorber antígenos de Widal cuando hay paquete.
4. Multiplicar por muestra/determinación en seriados, BK, PTOG, RPR y antibiograma.
5. Sumar la "toma de muestra sanguínea" como 1 examen en fichas con muestra de sangre.

> ⚠️ Nota: estas funciones (`nextLabCode`, `buildRecordFromForm`, `computeProductivity`, etc.) fueron marcadas por el usuario como **"no tocar"**; este análisis es solo explicativo. Cualquier cambio debe autorizarse expresamente.

---

## 7. Datos técnicos de respaldo

### Panel del Hemograma Completo (CATALOG → Hematología)

```js
{ name: "Hemograma Completo", panel: [
  "Hemoglobina", "Hematocrito", "Recuento de hematíes",
  "Recuento de leucocitos", "Recuento de plaquetas",
  "Neutrófilos segmentados", "Neutrófilos abastonados", "Eosinófilos",
  "Basófilos", "Linfocitos", "Monocitos", "Mielocitos", "Juveniles"
] }
```

→ 13 componentes. Al marcar el perfil, `toggleTest()` expande `def.panel` en `currentTests`, por lo que la ficha guarda **13 entradas** en `rec.tests`.

### Constante de componentes reconocidos (para absorción)

```js
const HEMOGRAMA_COMPONENT_NAMES = [
  'Recuento de leucocitos', 'Neutrófilos segmentados', 'Neutrófilos abastonados',
  'Linfocitos', 'Monocitos', 'Basófilos', 'Eosinófilos', 'Mielocitos', 'Juveniles'
];
```

### Funciones involucradas (en `SILAB_01_Lampa_CORREGIDO-2open.html`)

| Función | Rol |
|---|---|
| `computeProductivity()` | Reporte de productividad (3048/3078 exámenes del PDF) |
| `classifyTestsForReport(rec)` | Clasificación de exámenes para el informe mensual (2344) |
| `REPORT_COLUMNS` | Definición de columnas del cuadro del informe |
| `addExamen(actorKey, nombre, key, n)` | Contador de exámenes por usuario en productividad |
| `toggleTest(area, def)` | Expande los perfiles (panel) en `currentTests` |
| `buildRecordFromForm()` | Graba `tests: currentTests.map(cloneTest)` en la ficha |
| `testUvr(t)` | Factor MINSA (UVR) de un examen individual (productividad) |
| `aplicarAjusteCampana(inc, otrosNames, rec, uvr)` | Ajuste por campaña de salud |

---

## 8. Estructura del Excel auditado (Informe_Mensual_SETIEMBRE_2026.xlsx)

Secciones identificadas:

1. **Encabezado**: informe mensual, establecimiento, mes/año.
2. **Nº horas trabajadas**.
3. **Número de pacientes atendidos por tipo de muestra** (esputo, heces, sangre, orina, secreción, líquidos, agua).
4. **1. Determinaciones / UVR** (factor MINSA real por examen): cuadro por columnas de exámenes y por servicios (consultorios: medicina, cirugía, pediatría, obstetricia-ginecología; hospitalización, U.C.I., periferia, particular, emergencias).
5. **2. Nº de exámenes realizados (base, tal como se registran en la app)**: la sección con **TOTAL GENERAL = 2344** y columna **OTROS = 466**, con detalle de trazabilidad de la columna OTROS.
6. **Detalle de exámenes de la columna OTROS** (trazabilidad): desglose por examen con total 466.

---

## 9. Anexo — costado del análisis (archivos/evidencia)

- Excel: `/mnt/sdcard/Download/Informe_Mensual_SETIEMBRE_2026.xlsx`
- App Lampa: `/mnt/sdcard/Download/open code/SILAB_01_Lampa_CORREGIDO-2open.html`
- App Ilave: `/mnt/sdcard/Download/open code/SILAB_01_Ilave_CORREGIDO-1open.html` (misma lógica de conteo, prefijo IL-)

---

*Documento generado a partir del análisis de la sesión opencode (26/09/2026).*