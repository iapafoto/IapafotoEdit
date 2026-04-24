# IapafotoEdit — Éditeur SDF (Signed Distance Field)

Éditeur WebGL d'arborescence SDF avec rendu path-traced progressif, export Shadertoy. Pas de build/bundler : tout est en JS vanilla + React UMD via Babel standalone. Charger `index.html` directement.

## Ordre de chargement (index.html)
L'ordre est critique — chaque fichier dépend du précédent :
1. `glsl-library.js` — registre (consommé par tous)
2. `scene.js` — types + tree helpers
3. `materials.js` — palette + résolution
4. `compiler.js` — tree → GLSL
5. `renderer.js` — WebGL (consomme compiler)
6. `exporter.js` — Shadertoy
7. `App.jsx` — React UI (Babel standalone)

Tout exporte via `Object.assign(window, {...})`. Pas de modules ES.

## Fichiers

### glsl-library.js — registre GLSL + `SHAPE_REGISTRY`
- `GLSL_LIBRARY` : helpers GLSL (rotX/Y/Z, invT, sdSphere, sdRoundBox, sdCylinder, sdTorus, sdCapsuleCP, sdBezier, sdPlane)
- `SHAPE_REGISTRY` : **source de vérité unique pour chaque primitive**. Chaque entrée contient :
  - `label`, `icon`, `defaults`, `params` (pilote UI)
  - `glslDeps` (déduplication header)
  - `emit(pe, q, ctx)` → retourne `{ dExpr }` (expression GLSL de distance)
  - `uniformPack(params)` → floats `u_selParamsN`
  - `uniformLayout` → mapping `paramKey → 'u_selParamsX.y'`
- **Ajouter une forme = ajouter UNE entrée ici** (compiler, renderer, UI, export la consomment).

### scene.js — arbre + math
- Types : `SHAPE_TYPES`, `OP_TYPES` (union/subtraction/intersection), `MODIFIER_TYPES` (mirror/repeat/repeat_angular)
- Transforms vec3 : `position`, `rotation` [rx,ry,rz], `scale` (float uniforme)
- `worldPoint`/`localDelta` + versions `*Chain` : conversion local↔monde via chaîne d'ancêtres (le compilateur nest les `invT`)
- Tree helpers : `findNode`, `findParent`, `mapTree`, `removeFromTree`, `insertChild`, `insertSibling`, `moveNodeAt`, `flattenShapes`
- `createNode(type, name)` : chaque node a `{id, type, children, name, position, rotation, scale, params, materialId, pTransform, dTransform}`
- `materialId: null` → hérite du premier ancêtre avec un matériau (fallback palette[0])

### materials.js — palette
- Material = `{id, name, color, refl, rough, spec, specPow}`
- `resolveMaterial(ownId, inheritedId, palette)` — cascade : explicit > inherited > palette[0] > fallback
- `resolveUsedMaterials(root, palette)` — déduplique, retourne indices utilisés (bornes des branches `shapeCol`/`shapeMat`)
- `isMaterialReferenced` — compte d'usage (pour désactiver la suppression)

### compiler.js — `compileSDF(root, selectedId, palette, opts)`
Retourne `{ sceneFn, colorFn, matFn, header, extraFns, shapes, usedMaterials }`.
- `sceneFn` : `vec2 sceneMap(vec3 p)` → `(distance, materialId)`
- `colorFn`/`matFn` : branches `if(mid<N.5+.5)` sur les matériaux utilisés
- `materialUniforms: true` → lit `u_matCol[]`/`u_matMat[]` (éditeur rapide)
- `materialUniforms: false` → littéraux baked (export Shadertoy)
- **Fast path de sélection** : si `selectedId` match, les params sont émis comme uniforms `u_sel*` → édition live sans recompile shader
- `pTransform`/`dTransform`/`profile` GLSL utilisateur → helpers `pT_N` / `dT_N` / `profile_N` (auto-wrap : si pas de `return`, en ajoute un)
- `emitModifier` : mirror (avec eps lisse), repeat (axes indépendants + bornes), repeat_angular

### renderer.js — `SDFRenderer` (WebGL2 / GLSL ES 3.00)
- Contexte `webgl2` obligatoire (utilise `#define ZERO`, bitwise ops, `texture`, `out fragColor`)
- FBO float : `EXT_color_buffer_float` → `RGBA32F`, sinon `EXT_color_buffer_half_float` → `RGBA16F`, sinon byte
- Two-pass ping-pong : trace → FBO float progressif → present (gamma + vignette)
- Path tracer : `BOUNCE` rebonds, AO, soft shadows, `gaussianReflect`, `envMap`
- Accumulation : `maxAccum=1024`, invalidée via `_stateSig()` (camera/selection/tree)
- Caméra orbitale `{theta, phi, distance}`, vecteurs exposés via `getCamVecs()` + `projectToScreen()`
- `setSelection(node)` / `updateSelectedData(node)` — drive `u_sel*` chaque frame (fast path)
- `updateMaterials(tree, palette)` : si le nombre de matériaux dédupliqué n'a pas changé → pas de recompile
- Float FBO fallback : float → half-float → RGBA8 (warnings si banding)

### exporter.js — `exportShadertoyPathTraced(tree, palette, bounces)`
Buffer A (path tracer + accumulation via `iChannel0` self-feedback) + Image (gamma+vignette). Tout baked littéral (`materialUniforms: false`).

### App.jsx — UI React (~1600 lignes, monolithe)
State racine dans `App()` (ligne 966). Persistance : localStorage `iapafoto-edit:autosave:v1` + JSON download.

Sections de l'UI :
- **Top bar** : Add menu, mode (translate/rotate/scale), undo/redo, matériaux, bounces, new/save/load/export
- **Left panel** : arbre drag-and-drop (`TreeItem`), "Encapsuler dans..." (wrap dans un modifier)
- **Viewport central** : deux canvas superposés (`glCanvasRef` pour SDF, `gizmoCanvasRef` pour gizmo 2D overlay)
- **Right panel** : `PropsPanel` (transform, shape params via registry, material, GLSL pTransform/dTransform)
- **Modals** : `MaterialsModal`, `ExportModal`

Composants clés :
- `NumInput` (ligne 100) : drag horizontal + dblclick pour éditer
- `Vec3Row`, `GlslInput`, `Collapsible`, `PopupMenu`, `AddMenuContent`
- `TreeItem` (294) : drag-and-drop récursif avec drop zones before/inside/after
- `PropsPanel` (384) / `ShapeParams` (515) / `ModifierParams` (577) : UI pilotée par `SHAPE_REGISTRY.params`
- `drawGizmo` (653) + `hitTestGizmo` (779) : axes 3D projetés en 2D, picking

Undo/redo (1008+) : debounce 400ms — un drag continu = une étape d'undo. `historyRef.current = { past, future, lastCommitted, pending, debounce, suppress }`.

Fast path (`fastPathRef`) : si l'update touche UNIQUEMENT la sélection, pas de recompile — juste push des nouveaux `u_sel*` la frame suivante.

## Conventions
- Coordonnées GLSL : `invT(p, pos, rot, sc)` inverse avec `rotZ*rotY*rotX`. Côté JS, `unapplyRotationXYZ` fait l'équivalent forward.
- Scale uniforme (float scalaire) pour préserver la métrique SDF.
- Coûts d'ajout d'une primitive : **une seule entrée** dans `SHAPE_REGISTRY`. Le reste (compiler, renderer, UI, export) consomme la registry.
- Nouveaux helpers GLSL : ajouter à `GLSL_LIBRARY`, référencer via `glslDeps`. Base toujours émise : `rotX/Y/Z/invT`.
