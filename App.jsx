const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ── Project save/load ────────────────────────────────────────────
const PROJECT_FORMAT = 'iapafoto-edit';
const PROJECT_VERSION = 1;
const AUTOSAVE_KEY = 'iapafoto-edit:autosave:v1';
function serializeProject(tree, palette, camera, bounces, cameraParams, userLibrary) {
  return { format: PROJECT_FORMAT, version: PROJECT_VERSION, tree, palette, camera, bounces, cameraParams, userLibrary: userLibrary || [] };
}
function isValidProject(p) {
  return p && p.format === PROJECT_FORMAT && p.tree && Array.isArray(p.palette);
}
let _AUTOSAVE_CACHED = false, _AUTOSAVE_VALUE = null;
function readAutosaveOnce() {
  if (_AUTOSAVE_CACHED) return _AUTOSAVE_VALUE;
  _AUTOSAVE_CACHED = true;
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (isValidProject(p)) _AUTOSAVE_VALUE = p;
    }
  } catch {}
  return _AUTOSAVE_VALUE;
}

// ── Palette ──────────────────────────────────────────────────────
const C = {
  bg:'#0d0d11', panel:'#13131a', border:'#222232', border2:'#2a2a3e',
  text:'#c4c4d8', dim:'#666680', acc:'#5b8cff', selBg:'#162040', selBdr:'#5b8cff',
  X:'#ff4466', Y:'#44dd88', Z:'#4488ff', hover:'#1a1a28',
};
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));

// ── Color helpers (rgb[0..1] ↔ #rrggbb) ──────────────────────────
const rgbToHex = rgb => '#' + rgb.map(c => {
  const v = Math.max(0, Math.min(255, Math.round(c * 255)));
  return v.toString(16).padStart(2,'0');
}).join('');
const hexToRgb = hex => {
  const h = (hex||'').replace('#','');
  if (h.length !== 6) return [1,1,1];
  return [0,2,4].map(i => parseInt(h.slice(i,i+2),16)/255);
};

// Walk the tree following `id` and return the first explicit materialId
// found on an ancestor chain (used to preview the inherited color when a
// node itself has materialId=null).
function findInheritedMaterialId(root, id) {
  // DFS with path stack.
  const stack = [{ node:root, inh:null }];
  while (stack.length) {
    const { node, inh } = stack.pop();
    if (node.id === id) return inh;
    const next = node.materialId || inh;
    for (const c of (node.children||[])) stack.push({ node:c, inh:next });
  }
  return null;
}

function getCamVecs(cam) {
  const { theta, phi, distance } = cam;
  const x = distance * Math.cos(phi) * Math.sin(theta);
  const y = distance * Math.sin(phi);
  const z = distance * Math.cos(phi) * Math.cos(theta);
  const eye = [x, y, z];
  const fwd = normalize3([-x,-y,-z]);
  const right = normalize3(cross3(fwd,[0,1,0]));
  const up = cross3(right, fwd);
  return { eye, fwd, right, up };
}
function projectPt(p, cam, w, h) {
  const { eye, fwd, right, up } = getCamVecs(cam);
  const fL = (cam && typeof cam.focalLen === 'number') ? cam.focalLen : 1;
  const v = sub3(p, eye);
  const vf = dot3(v, fwd);
  if (vf <= 0.01) return null;
  return { x: dot3(v,right)/vf*h*fL + w/2, y: h/2 - dot3(v,up)/vf*h*fL, depth: vf };
}

// ── Btn ───────────────────────────────────────────────────────────
function Btn({ children, onClick, active, danger, small, title, disabled }) {
  const [hov, setHov] = useState(false);
  const bg = danger ? (hov?'#5a1a22':'#3a1018') : active ? C.acc : hov ? C.hover : 'transparent';
  const col = danger ? '#ff6677' : active ? '#fff' : C.text;
  return (
    <button title={title} onClick={onClick} disabled={disabled}
      onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)}
      style={{ background:bg, color:col, border:`1px solid ${active?C.acc:C.border}`,
        borderRadius:4, padding:small?'2px 7px':'4px 10px',
        fontSize:small?10:11, fontFamily:'inherit', cursor:disabled?'default':'pointer',
        opacity:disabled?.5:1, transition:'all .12s', whiteSpace:'nowrap' }}>
      {children}
    </button>
  );
}

// ── NumInput (drag + dblclick edit) ──────────────────────────────
function NumInput({ value, onChange, step=0.01, min, max, width=58 }) {
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState('');
  const start = useCallback((e) => {
    e.preventDefault();
    const sx = e.clientX, sv = value;
    const move = ev => {
      let nv = sv + (ev.clientX - sx) * step;
      if (min !== undefined) nv = Math.max(min, nv);
      if (max !== undefined) nv = Math.min(max, nv);
      onChange(parseFloat(nv.toFixed(4)));
    };
    const up = () => { window.removeEventListener('mousemove',move); window.removeEventListener('mouseup',up); };
    window.addEventListener('mousemove',move); window.addEventListener('mouseup',up);
  }, [value, step, min, max, onChange]);
  if (editing) return (
    <input value={local} onChange={e=>setLocal(e.target.value)}
      onBlur={()=>{ const v=parseFloat(local); if(!isNaN(v)) onChange(v); setEditing(false); }}
      onKeyDown={e=>{ if(e.key==='Enter'||e.key==='Escape'){const v=parseFloat(local);if(!isNaN(v))onChange(v);setEditing(false);} }}
      style={{ width, background:'#0a0a14', color:C.text, border:`1px solid ${C.acc}`,
        borderRadius:3, padding:'2px 4px', fontSize:11, fontFamily:'IBM Plex Mono,monospace' }}
      autoFocus onFocus={e=>e.target.select()} />
  );
  return (
    <div onMouseDown={start} onDoubleClick={()=>{setLocal(value.toFixed(3));setEditing(true);}}
      style={{ width, background:'#0d0d18', border:`1px solid ${C.border}`, borderRadius:3,
        padding:'2px 5px', fontSize:11, color:'#e0e0f0', cursor:'ew-resize', userSelect:'none',
        textAlign:'right', fontFamily:'IBM Plex Mono,monospace' }}>
      {value.toFixed(3)}
    </div>
  );
}

// ── Vec3 row ──────────────────────────────────────────────────────
function Vec3Row({ label, value, onChange, step=0.01, labels=['X','Y','Z'] }) {
  const COLS = [C.X, C.Y, C.Z];
  return (
    <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:4 }}>
      <span style={{ width:60, fontSize:10, color:C.dim, flexShrink:0 }}>{label}</span>
      {[0,1,2].map(i=>(
        <div key={i} style={{ display:'flex', alignItems:'center', gap:2 }}>
          <span style={{ fontSize:9, color:COLS[i], fontWeight:700, width:10 }}>{labels[i]}</span>
          <NumInput value={value[i]} step={step}
            onChange={v=>{ const nv=[...value]; nv[i]=v; onChange(nv); }} />
        </div>
      ))}
    </div>
  );
}

// ── GLSL textarea (profile, pTransform, dTransform) ───────────────
// Small fixed-height code input. Blur commits the change so the user
// can't accidentally trigger a recompile per keystroke.
function GlslInput({ label, value, placeholder, onChange, rows=2 }) {
  const [local, setLocal] = useState(value || '');
  useEffect(()=>{ setLocal(value || ''); }, [value]);
  return (
    <div style={{ marginBottom:6 }}>
      <div style={{ fontSize:10, color:C.dim, marginBottom:2 }}>{label}</div>
      <textarea value={local} rows={rows} placeholder={placeholder||''}
        onChange={e=>setLocal(e.target.value)}
        onBlur={()=>{ if (local !== value) onChange(local); }}
        spellCheck={false}
        style={{ width:'100%', background:'#0a0a12', border:`1px solid ${C.border}`,
          borderRadius:3, padding:'4px 6px', color:'#b8d4ff', fontSize:10,
          fontFamily:'IBM Plex Mono,monospace', resize:'vertical', minHeight:20 }}/>
    </div>
  );
}

// Collapsible section with a chevron toggle.
function Collapsible({ title, children, defaultOpen=false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom:10 }}>
      <div onClick={()=>setOpen(o=>!o)}
        style={{ display:'flex', alignItems:'center', gap:4, cursor:'pointer',
          fontSize:10, color:C.dim, textTransform:'uppercase', letterSpacing:'.08em',
          borderBottom:`1px solid ${C.border}`, paddingBottom:4, marginBottom:6, userSelect:'none' }}>
        <span style={{ width:10 }}>{open?'▾':'▸'}</span>{title}
      </div>
      {open && children}
    </div>
  );
}

// ── MenuSection / MenuItem ────────────────────────────────────────
function MenuSection({ label, children }) {
  return (
    <div>
      <div style={{ padding:'6px 10px 2px', fontSize:9, color:C.dim, textTransform:'uppercase', letterSpacing:'.07em' }}>{label}</div>
      {children}
    </div>
  );
}
function MenuItem({ icon, label, onClick, color }) {
  const [hov, setHov] = useState(false);
  return (
    <div onClick={onClick} onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)}
      style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 12px',
        cursor:'pointer', background:hov?C.hover:'transparent', fontSize:11, color:color||C.text }}>
      <span style={{ fontFamily:'monospace', width:18, textAlign:'center', opacity:.7 }}>{icon}</span>
      {label}
    </div>
  );
}

// ── Inline popup menu (shared) ────────────────────────────────────
// The menu is rendered via a portal on document.body so it can escape
// any ancestor with `overflow:hidden/auto` (e.g. the scrollable tree).
function PopupMenu({ trigger, children }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos]   = useState({ top:0, left:0 });
  const triggerRef      = useRef();
  const menuRef         = useRef();

  const openAt = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    // Flip horizontally if menu would overflow the right edge
    const MIN_W = 180;
    const left = Math.min(r.left, window.innerWidth - MIN_W - 8);
    setPos({ top: r.bottom + 2, left: Math.max(8, left) });
    setOpen(true);
  };
  const toggle = () => open ? setOpen(false) : openAt();

  useEffect(() => {
    if (!open) return;
    const onDown = e => {
      if (menuRef.current?.contains(e.target)) return;
      if (triggerRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onScroll = () => setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  return (
    <>
      <span ref={triggerRef} style={{ display:'inline-flex' }}>
        {trigger(open, toggle)}
      </span>
      {open && ReactDOM.createPortal(
        <div ref={menuRef}
          style={{ position:'fixed', top:pos.top, left:pos.left, zIndex:1000,
            background:'#13131a', border:`1px solid ${C.border2}`, borderRadius:6,
            minWidth:180, maxHeight:'min(70vh,500px)', overflowY:'auto',
            boxShadow:'0 8px 28px rgba(0,0,0,.75)' }}
          onMouseDown={e=>e.stopPropagation()}>
          {children(()=>setOpen(false))}
        </div>,
        document.body
      )}
    </>
  );
}

// ── AddMenu shared content ────────────────────────────────────────
function AddMenuContent({ onAdd, close, userLibrary }) {
  return (
    <>
      <MenuSection label="Shapes">
        {SHAPE_TYPES.map(t=>(
          <MenuItem key={t} icon={SHAPE_ICONS[t]} label={SHAPE_LABELS[t]} color='#7799ff'
            onClick={()=>{ onAdd(t); close(); }} />
        ))}
      </MenuSection>
      <div style={{ borderTop:`1px solid ${C.border}`, marginTop:2 }}/>
      <MenuSection label="Groups / Operations">
        {OP_TYPES.map(t=>(
          <MenuItem key={t} icon={OP_ICONS[t]} label={OP_LABELS[t]} color='#ffaa55'
            onClick={()=>{ onAdd(t); close(); }} />
        ))}
      </MenuSection>
      <div style={{ borderTop:`1px solid ${C.border}`, marginTop:2 }}/>
      <MenuSection label="Domain Modifiers">
        {MODIFIER_TYPES.map(t=>(
          <MenuItem key={t} icon={MODIFIER_ICONS[t]} label={MODIFIER_LABELS[t]} color='#bb88ff'
            onClick={()=>{ onAdd(t); close(); }} />
        ))}
      </MenuSection>
      {userLibrary && userLibrary.length > 0 && (
        <>
          <div style={{ borderTop:`1px solid ${C.border}`, marginTop:2 }}/>
          <MenuSection label="Bibliothèque">
            {userLibrary.map(entry=>(
              <MenuItem key={entry.id} icon={entry.icon||'◉'} label={entry.label} color='#44ddcc'
                onClick={()=>{ onAdd('library_ref', entry); close(); }} />
            ))}
          </MenuSection>
        </>
      )}
    </>
  );
}

// ── Tree Node ─────────────────────────────────────────────────────
function TreeItem({ node, depth, selectedId, isRoot, onSelect, onAdd, onDelete, onDragStart, onDragOver, onDrop, dropTarget }) {
  const [open, setOpen] = useState(true);
  const [hov, setHov] = useState(false);
  const isLibRef = node.type === 'library_ref';
  const isShape = SHAPE_TYPES.includes(node.type);
  const isOp    = OP_TYPES.includes(node.type);
  const isMod   = MODIFIER_TYPES.includes(node.type);
  const isGroup = isOp || isMod;
  const isSel   = node.id === selectedId;
  const isDrop  = dropTarget && dropTarget.id === node.id;
  const dropMode= isDrop ? dropTarget.mode : null;
  const tint    = isLibRef ? '#44ddcc' : isShape ? '#7799ff' : isMod ? '#bb88ff' : '#ffaa55';
  const icon    = isLibRef ? (node.icon || '◉') : isShape ? SHAPE_ICONS[node.type] : isMod ? MODIFIER_ICONS[node.type] : OP_ICONS[node.type];

  // Compute drop mode from mouse Y within the row.
  // Groups have a 3-zone layout (before / inside / after);
  // shapes only have 2 (before / after). Root can't be a sibling.
  const computeMode = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const h = rect.height;
    if (isGroup) {
      if (isRoot)               return 'inside';
      if (y < h * 0.25)         return 'before';
      if (y > h * 0.75)         return 'after';
      return 'inside';
    }
    return y < h * 0.5 ? 'before' : 'after';
  };

  return (
    <div>
      <div
        draggable={!isRoot}
        onDragStart={e=>{ if(isRoot){e.preventDefault();return;} e.stopPropagation(); onDragStart(node.id); }}
        onDragOver={e=>{ e.preventDefault(); e.stopPropagation(); onDragOver(node.id, computeMode(e)); }}
        onDrop={e=>{ e.preventDefault(); e.stopPropagation(); onDrop(node.id, computeMode(e)); }}
        style={{
          display:'flex', alignItems:'center', height:26, paddingLeft:8+depth*14,
          paddingRight:4, cursor:'pointer', userSelect:'none', position:'relative',
          background: dropMode === 'inside' ? '#1a2818' : isSel ? C.selBg : hov ? C.hover : 'transparent',
          borderLeft:`2px solid ${dropMode==='inside'?C.Y:isSel?C.selBdr:'transparent'}`,
          boxShadow: dropMode === 'before' ? `inset 0 2px 0 ${C.Y}`
                  : dropMode === 'after'  ? `inset 0 -2px 0 ${C.Y}`
                  : 'none',
        }}
        onClick={()=>onSelect(node.id)}
        onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)}
      >
        {isGroup && (
          <span onClick={e=>{e.stopPropagation();setOpen(o=>!o);}}
            style={{ color:C.dim, fontSize:9, marginRight:3, width:10, flexShrink:0 }}>
            {open?'▾':'▸'}
          </span>
        )}
        {isShape && <span style={{ width:13 }}/>}
        <span style={{ fontSize:11, color:tint, marginRight:6, fontFamily:'monospace', flexShrink:0 }}>
          {icon}
        </span>
        <span style={{ flex:1, fontSize:11, color:isSel?'#fff':C.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
          {node.name}
        </span>
        {(isSel || hov) && (
          <div style={{ display:'flex', gap:2, marginLeft:4 }} onClick={e=>e.stopPropagation()}>
            {isGroup && (
              <PopupMenu trigger={(open, toggle)=>(
                <button onClick={toggle}
                  style={{ background:open?C.acc:'rgba(255,255,255,.08)', color:open?'#fff':'#88aaff',
                    border:'none', borderRadius:3, padding:'1px 7px', fontSize:11,
                    cursor:'pointer', fontFamily:'inherit', lineHeight:'16px' }}>+</button>
              )}>
                {close=><AddMenuContent onAdd={t=>onAdd(t, node.id)} close={close}/>}
              </PopupMenu>
            )}
            <button onClick={()=>onDelete(node.id)}
              style={{ background:'rgba(255,60,80,.12)', color:'#ff6677', border:'none',
                borderRadius:3, padding:'1px 7px', fontSize:11, cursor:'pointer',
                fontFamily:'inherit', lineHeight:'16px' }}>✕</button>
          </div>
        )}
      </div>
      {isGroup && open && (node.children||[]).map(c=>(
        <TreeItem key={c.id} node={c} depth={depth+1} selectedId={selectedId}
          onSelect={onSelect} onAdd={onAdd} onDelete={onDelete}
          onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} dropTarget={dropTarget} />
      ))}
    </div>
  );
}

// ── Properties Panel ──────────────────────────────────────────────
function PropsPanel({ node, onChange, palette, tree, isRoot, onOpenMaterials, userLibrary, onEditLibrary }) {
  if (!node) return (
    <div style={{ padding:16, color:C.dim, fontSize:11, textAlign:'center', paddingTop:40, lineHeight:1.7 }}>
      Sélectionnez un objet<br/>pour éditer ses propriétés
    </div>
  );
  const isShape = SHAPE_TYPES.includes(node.type);
  const isOp    = OP_TYPES.includes(node.type);
  const isMod   = MODIFIER_TYPES.includes(node.type);
  const upd  = (k,v) => onChange({ [k]:v });
  const updP = (k,v) => onChange({ params:{ ...node.params, [k]:v } });

  // Effective material = own id OR inherited id (walked from tree root).
  // The swatch shows the *resolved* color so the user sees the cascade in action.
  const inheritedId = node.materialId ? null : findInheritedMaterialId(tree, node.id);
  const effective   = resolveMaterial(node.materialId, inheritedId, palette);
  const inheriting  = !node.materialId;
  const hasPalette  = palette && palette.length > 0;

  return (
    <div style={{ padding:10, overflowY:'auto', flex:1 }}>
      <div style={{ marginBottom:12 }}>
        <PropLabel>Nom</PropLabel>
        <input value={node.name} onChange={e=>upd('name',e.target.value)}
          style={{ width:'100%', background:'#0d0d18', border:`1px solid ${C.border}`,
            borderRadius:3, padding:'3px 6px', color:C.text, fontSize:11, fontFamily:'inherit' }} />
      </div>

      {/* Material picker — cascade aware. Available on shapes AND groups so
          setting a material on a group propagates to descendants without
          their own materialId. Root hides the "Inherit" option (nothing to
          inherit from). */}
      <div style={{ marginBottom:12 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:3 }}>
          <span style={{ fontSize:10, color:C.dim, textTransform:'uppercase', letterSpacing:'.06em' }}>Matériau</span>
          <button onClick={onOpenMaterials}
            style={{ background:'transparent', color:C.acc, border:'none',
              fontSize:10, cursor:'pointer', fontFamily:'inherit', padding:'0 2px' }}>
            Éditer…
          </button>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <span title={`Couleur effective (${effective.name})`}
            style={{ width:16, height:16, borderRadius:3,
              background:rgbToHex(effective.color),
              border:`1px solid ${C.border2}`, flexShrink:0 }}/>
          <select value={node.materialId || ''}
            onChange={e=>upd('materialId', e.target.value || null)}
            disabled={!hasPalette}
            style={{ flex:1, background:'#0d0d18', border:`1px solid ${C.border}`,
              borderRadius:3, padding:'3px 6px', color:C.text, fontSize:11, fontFamily:'inherit',
              fontStyle: inheriting ? 'italic' : 'normal' }}>
            {!isRoot && <option value="">— Hérite —</option>}
            {(palette||[]).map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>
        {inheriting && !isRoot && (
          <div style={{ fontSize:9, color:C.dim, marginTop:3, lineHeight:1.4 }}>
            Hérite de {effective.name}
          </div>
        )}
      </div>

      {isOp && (
        <div style={{ marginBottom:12 }}>
          <PropLabel>Opération</PropLabel>
          <select value={node.type} onChange={e=>onChange({ type:e.target.value, params:{...OP_DEFAULTS[e.target.value], ...node.params} })}
            style={{ width:'100%', background:'#0d0d18', border:`1px solid ${C.border}`,
              borderRadius:3, padding:'3px 6px', color:C.text, fontSize:11, fontFamily:'inherit' }}>
            {OP_TYPES.map(t=><option key={t} value={t}>{OP_LABELS[t]}</option>)}
          </select>
        </div>
      )}
      {isOp && (
        <div style={{ marginBottom:12 }}>
          <PropLabel>Smooth blend (k)</PropLabel>
          <NumInput value={node.params.k||0} step={0.005} min={0} max={2} onChange={v=>updP('k',v)} width={80}/>
        </div>
      )}
      {isMod && (
        <div style={{ marginBottom:12 }}>
          <SecTitle>{MODIFIER_LABELS[node.type]}</SecTitle>
          <ModifierParams node={node} updP={updP}/>
        </div>
      )}
      {(isOp || isMod) && (
        <div style={{ marginBottom:8, fontSize:10, color:C.dim, lineHeight:1.5 }}>
          Drag-and-drop objects into this node to parent them here.
        </div>
      )}
      {isShape && (
        <div style={{ marginBottom:12 }}>
          <SecTitle>Forme</SecTitle>
          <ShapeParams node={node} updP={updP}/>
        </div>
      )}
      {node.type === 'library_ref' && (() => {
        const entry = (userLibrary || []).find(e => e.id === node.libraryId);
        if (!entry) return (
          <div style={{ marginBottom:12, padding:8, background:'rgba(255,60,80,.08)',
            border:`1px solid rgba(255,60,80,.3)`, borderRadius:3, fontSize:10, color:'#ff8899' }}>
            Entrée bibliothèque introuvable ({node.libraryId})
          </div>
        );
        return (
          <div style={{ marginBottom:12 }}>
            <SecTitle>Bibliothèque · {entry.label}</SecTitle>
            {(entry.params || []).map(p => {
              const val = (node.params || {})[p.key];
              if (p.type === 'vec3') {
                return <Vec3Row key={p.key} label={p.label}
                  value={val || p.default || [0,0,0]}
                  onChange={v=>updP(p.key, v)} step={p.step||0.01}/>;
              }
              return <PR key={p.key} label={p.label}
                v={val ?? p.default ?? 0}
                onChange={v=>updP(p.key, v)}
                step={p.step||0.01} min={p.min}/>;
            })}
            <button onClick={()=>onEditLibrary && onEditLibrary(entry)}
              style={{ marginTop:6, width:'100%', background:'rgba(68,221,204,.08)',
                color:'#44ddcc', border:`1px solid rgba(68,221,204,.3)`,
                borderRadius:3, padding:'3px 0', fontSize:10, cursor:'pointer', fontFamily:'inherit' }}>
              ⬟ Éditer dans bibliothèque
            </button>
          </div>
        );
      })()}
      {(isShape || isOp || isMod || node.type === 'library_ref') && (
        <div style={{ marginBottom:12 }}>
          <SecTitle>{isShape || node.type === 'library_ref' ? 'Transform' : 'Group Transform'}</SecTitle>
          <Vec3Row label="Position" value={node.position||[0,0,0]} onChange={v=>upd('position',v)}/>
          <Vec3Row label="Rotation" value={(node.rotation||[0,0,0]).map(deg)} onChange={v=>upd('rotation',v.map(rad))} step={0.5}/>
          <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
            <span style={{ width:60, fontSize:10, color:C.dim, flexShrink:0 }}>Scale</span>
            <NumInput value={typeof node.scale==='number'?node.scale:1}
              step={0.01} min={0.01} width={72}
              onChange={v=>upd('scale', Math.max(0.01, v))}/>
          </div>
        </div>
      )}

      {/* Phase 6 — free-form GLSL snippets for domain/distance warping. */}
      <Collapsible title="Advanced (GLSL)">
        <GlslInput label="pTransform(p) → vec3"
          value={node.pTransform || ''}
          placeholder="ex: p.y += .05*sin(p.x*10.); return p;"
          rows={2}
          onChange={v=>upd('pTransform', v)}/>
        <GlslInput label="dTransform(d, p) → float"
          value={node.dTransform || ''}
          placeholder="ex: return d + .02*sin(50.*p.x);"
          rows={2}
          onChange={v=>upd('dTransform', v)}/>
      </Collapsible>
    </div>
  );
}

// Shape params are driven entirely from SHAPE_REGISTRY[type].params.
// Supported types: 'number' (PR row), 'vec3' (Vec3Row), 'glsl' (textarea).
function ShapeParams({ node, updP }) {
  const reg = SHAPE_REGISTRY[node.type];
  if (!reg) return null;
  const params = node.params || {};
  return (
    <>
      {(reg.params||[]).map(p => {
        if (p.type === 'vec3') {
          return <Vec3Row key={p.key} label={p.label}
            value={params[p.key] || [0,0,0]}
            onChange={v=>updP(p.key, v)} step={p.step||0.01}/>;
        }
        if (p.type === 'glsl') {
          return <GlslInput key={p.key} label={p.label}
            value={params[p.key] || ''}
            placeholder="ex: 1. + .3*sin(k*10.)"
            rows={2}
            onChange={v=>updP(p.key, v)}/>;
        }
        // 'number' (default). Pass min only if explicitly set by registry
        // — plane offset, etc. need unbounded negatives.
        return <PR key={p.key} label={p.label}
          v={params[p.key]||0}
          onChange={v=>updP(p.key, v)}
          step={p.step||0.01}
          min={p.min}/>;
      })}
    </>
  );
}
function PropLabel({ children }) {
  return <div style={{ fontSize:10, color:C.dim, marginBottom:3, textTransform:'uppercase', letterSpacing:'.06em' }}>{children}</div>;
}
function SecTitle({ children }) {
  return <div style={{ fontSize:10, color:C.dim, textTransform:'uppercase', letterSpacing:'.08em', borderBottom:`1px solid ${C.border}`, paddingBottom:4, marginBottom:8 }}>{children}</div>;
}
function PR({ label, v, onChange, min, step=0.01 }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:5 }}>
      <span style={{ width:60, fontSize:11, color:C.text, flexShrink:0 }}>{label}</span>
      <NumInput value={v||0} step={step} min={min} onChange={onChange} width={72}/>
    </div>
  );
}
function Check({ label, v, onChange, color }) {
  return (
    <label style={{ display:'flex', alignItems:'center', gap:5, fontSize:11, color:C.text, cursor:'pointer', userSelect:'none' }}>
      <input type="checkbox" checked={!!v} onChange={e=>onChange(e.target.checked)}
        style={{ accentColor:color||C.acc }}/>
      <span style={{ color: color||C.text, fontWeight:600 }}>{label}</span>
    </label>
  );
}
function AxesCheckboxes({ p, updP }) {
  return (
    <div style={{ display:'flex', gap:10, marginBottom:6 }}>
      <Check label="X" v={p.x} onChange={v=>updP('x',v)} color={C.X}/>
      <Check label="Y" v={p.y} onChange={v=>updP('y',v)} color={C.Y}/>
      <Check label="Z" v={p.z} onChange={v=>updP('z',v)} color={C.Z}/>
    </div>
  );
}
function ModifierParams({ node, updP }) {
  const p = node.params || {};
  if (node.type === 'mirror') {
    return (
      <>
        <AxesCheckboxes p={p} updP={updP}/>
        <PR label="Smooth (eps)" v={p.eps||0} onChange={v=>updP('eps',v)} step={0.005} min={0}/>
      </>
    );
  }
  if (node.type === 'repeat') {
    // Per-axis: cell size (s) + half-count (n). n=0 disables repetition on that axis.
    const row = (axisKey, color) => (
      <div key={axisKey} style={{ display:'flex', alignItems:'center', gap:4, marginBottom:4 }}>
        <span style={{ width:14, fontSize:10, fontWeight:700, color, flexShrink:0 }}>{axisKey.toUpperCase()}</span>
        <span style={{ fontSize:9, color:C.dim }}>size</span>
        <NumInput value={p['s'+axisKey]||1} step={0.02} min={0.01} width={56}
          onChange={v=>updP('s'+axisKey, v)}/>
        <span style={{ fontSize:9, color:C.dim, marginLeft:4 }}>±n</span>
        <NumInput value={p['n'+axisKey]||0} step={1} min={0} width={40}
          onChange={v=>updP('n'+axisKey, Math.max(0,Math.round(v)))}/>
      </div>
    );
    return <>{row('x',C.X)}{row('y',C.Y)}{row('z',C.Z)}</>;
  }
  if (node.type === 'repeat_angular') {
    return (
      <>
        <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:5 }}>
          <span style={{ width:60, fontSize:11, color:C.text }}>Count</span>
          <NumInput value={p.count||6} step={0.1} min={0.01} width={60}
            onChange={v=>updP('count', Math.max(0.01, v))}/>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:5 }}>
          <span style={{ width:60, fontSize:11, color:C.text }}>Reps</span>
          <NumInput value={p.reps||0} step={1} min={0} width={60}
            onChange={v=>updP('reps', Math.max(0,Math.round(v)))}/>
          <span style={{ fontSize:9, color:C.dim }}>0 = full</span>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:5 }}>
          <span style={{ width:60, fontSize:11, color:C.text }}>Axis</span>
          <select value={p.axis||'y'} onChange={e=>updP('axis', e.target.value)}
            style={{ background:'#0d0d18', border:`1px solid ${C.border}`, borderRadius:3,
              padding:'2px 6px', color:C.text, fontSize:11, fontFamily:'inherit' }}>
            <option value="x">X</option><option value="y">Y</option><option value="z">Z</option>
          </select>
        </div>
      </>
    );
  }
  return null;
}

// ── Gizmo ────────────────────────────────────────────────────────
const AXES = [
  { id:'x', dir:[1,0,0], col:C.X, label:'X' },
  { id:'y', dir:[0,1,0], col:C.Y, label:'Y' },
  { id:'z', dir:[0,0,1], col:C.Z, label:'Z' },
];

// Shape-specific control points (local coords). Returned in draw order.
// Colors rotate through X/Y/Z so the first handle is pink, second green, etc.
function getControlPoints(node) {
  if (!node) return [];
  const p = node.params || {};
  const CP_COLORS = [C.X, C.Y, C.Z];
  if (node.type === 'capsule') {
    return [
      { key:'a', pos: p.a || [0,-0.2,0], label:'A', col:CP_COLORS[0] },
      { key:'b', pos: p.b || [0, 0.2,0], label:'B', col:CP_COLORS[1] },
    ];
  }
  if (node.type === 'bezier') {
    return [
      { key:'b0', pos: p.b0 || [-0.3,0,0], label:'P0', col:CP_COLORS[0] },
      { key:'b1', pos: p.b1 || [ 0,0.4,0], label:'P1', col:CP_COLORS[1] },
      { key:'b2', pos: p.b2 || [ 0.3,0,0], label:'P2', col:CP_COLORS[2] },
    ];
  }
  return [];
}

function drawGizmo(ctx, selNode, ancestors, mode, activeAxis, cam, w, h) {
  ctx.clearRect(0,0,w,h);
  if (!selNode) return;
  // Gizmo origin = shape's actual world position (chains ancestor transforms).
  const worldOrigin = worldPointChain(ancestors, selNode, [0,0,0]);
  const origin = projectPt(worldOrigin, cam, w, h);
  if (!origin || origin.depth < 0.01) return;
  const gLen = clamp(0.55 * cam.distance / 3, 0.18, 1.6);
  const sorted = AXES.map(a=>{
    const end = projectPt(add3(worldOrigin,scale3(a.dir,gLen)), cam, w, h);
    return {...a, end};
  }).filter(a=>a.end).sort((a,b)=>b.end.depth - a.end.depth);

  for (const ax of sorted) {
    const active = activeAxis === ax.id;
    const ox=origin.x, oy=origin.y, ex=ax.end.x, ey=ax.end.y;
    const dx=ex-ox, dy=ey-oy, l=Math.sqrt(dx*dx+dy*dy)||1;
    const nx=dx/l, ny=dy/l;
    ctx.globalAlpha = active ? 1.0 : 0.82;
    ctx.strokeStyle = ax.col; ctx.fillStyle = ax.col; ctx.lineWidth = active?3:2;

    if (mode==='translate'||mode==='select') {
      ctx.beginPath(); ctx.moveTo(ox,oy); ctx.lineTo(ex,ey); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ex,ey);
      ctx.lineTo(ex-nx*13-ny*5, ey-ny*13+nx*5);
      ctx.lineTo(ex-nx*13+ny*5, ey-ny*13-nx*5);
      ctx.closePath(); ctx.fill();
    } else if (mode==='rotate') {
      const r = l*0.72;
      ctx.beginPath(); ctx.arc(ox,oy,r,-Math.PI*.65,Math.PI*.65); ctx.stroke();
      const ex2=ox+Math.cos(Math.PI*.65)*r, ey2=oy+Math.sin(Math.PI*.65)*r;
      ctx.beginPath();
      ctx.moveTo(ex2,ey2);
      ctx.lineTo(ex2+ny*9-nx*4, ey2-nx*9-ny*4);
      ctx.lineTo(ex2+ny*9+nx*4, ey2-nx*9+ny*4);
      ctx.closePath(); ctx.fill();
    } else if (mode==='scale') {
      ctx.beginPath(); ctx.moveTo(ox,oy); ctx.lineTo(ex,ey); ctx.stroke();
      const s=active?8:6;
      ctx.fillRect(ex-s/2,ey-s/2,s,s);
    }
    ctx.globalAlpha=0.9;
    ctx.font='bold 11px IBM Plex Mono,monospace';
    ctx.fillText(ax.label, ex+nx*10, ey+ny*10+4);
  }
  ctx.globalAlpha=1;
  ctx.fillStyle='#ffffff';
  ctx.beginPath(); ctx.arc(origin.x,origin.y,3.5,0,Math.PI*2); ctx.fill();

  // Control-point handles for capsule/bezier. Drawn after the axes so they
  // stay on top; guideline connects them visually (segment / bezier curve).
  const cps = getControlPoints(selNode);
  if (cps.length) {
    const cpGLen = gLen * 0.6;
    const screened = cps.map(cp => {
      const world = worldPointChain(ancestors, selNode, cp.pos);
      return { ...cp, world, screen: projectPt(world, cam, w, h) };
    }).filter(c => c.screen);
    // Polyline connector
    if (screened.length >= 2) {
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.2;
      ctx.setLineDash([3,3]);
      ctx.beginPath();
      if (selNode.type === 'bezier' && screened.length === 3) {
        const [p0,p1,p2] = screened.map(c=>c.screen);
        ctx.moveTo(p0.x,p0.y);
        ctx.quadraticCurveTo(p1.x,p1.y, p2.x,p2.y);
      } else {
        ctx.moveTo(screened[0].screen.x, screened[0].screen.y);
        for (let i=1;i<screened.length;i++) ctx.lineTo(screened[i].screen.x, screened[i].screen.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    // Mini XYZ axis arrows on each control point (drawn before dots so dots stay on top)
    for (const cp of screened) {
      const cpAxes = AXES.map(ax => ({
        ...ax, end: projectPt(add3(cp.world, scale3(ax.dir, cpGLen)), cam, w, h),
      })).filter(ax => ax.end).sort((a,b) => b.end.depth - a.end.depth);
      for (const ax of cpAxes) {
        const active = activeAxis === `cp:${cp.key}:${ax.id}`;
        const ox=cp.screen.x, oy=cp.screen.y, ex=ax.end.x, ey=ax.end.y;
        const dx=ex-ox, dy=ey-oy, l=Math.sqrt(dx*dx+dy*dy)||1;
        const nx=dx/l, ny=dy/l;
        ctx.globalAlpha = active ? 1.0 : 0.45;
        ctx.strokeStyle = ax.col; ctx.fillStyle = ax.col; ctx.lineWidth = active ? 2.5 : 1.5;
        ctx.beginPath(); ctx.moveTo(ox,oy); ctx.lineTo(ex,ey); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(ex,ey);
        ctx.lineTo(ex-nx*9-ny*3.5, ey-ny*9+nx*3.5);
        ctx.lineTo(ex-nx*9+ny*3.5, ey-ny*9-nx*3.5);
        ctx.closePath(); ctx.fill();
        if (active) {
          ctx.globalAlpha = 0.9;
          ctx.font = 'bold 9px IBM Plex Mono,monospace';
          ctx.fillText(ax.label, ex+nx*7, ey+ny*7+3);
        }
      }
      ctx.globalAlpha = 1;
    }
    // CP dots (drawn last so they sit on top of axis lines)
    for (const cp of screened) {
      const activeDot = activeAxis === `cp:${cp.key}` || activeAxis?.startsWith(`cp:${cp.key}:`);
      const { x, y } = cp.screen;
      const r = activeDot ? 7 : 5;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = cp.col; ctx.lineWidth = activeDot ? 3 : 2;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fill(); ctx.stroke();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = cp.col;
      ctx.font='bold 10px IBM Plex Mono,monospace';
      ctx.fillText(cp.label, x + r + 3, y + 4);
      ctx.globalAlpha = 1;
    }
  }
}

// Projects a 2D mouse delta onto a world-space axis, returns the scalar movement.
// Used by both shape translate and CP axis drag.
function dragAxisDelta(dx, dy, axDir, right, up, scale) {
  return (dx * dot3(axDir, right) - dy * dot3(axDir, up)) * scale;
}

function hitTestGizmo(mx, my, selNode, ancestors, mode, cam, w, h) {
  if (!selNode) return null;
  const cps = getControlPoints(selNode);
  // CP center dots first — exact 10px hit, highest priority.
  for (const cp of cps) {
    const s = projectPt(worldPointChain(ancestors, selNode, cp.pos), cam, w, h);
    if (!s) continue;
    if (Math.hypot(mx - s.x, my - s.y) < 10) return `cp:${cp.key}`;
  }
  const worldOrigin = worldPointChain(ancestors, selNode, [0,0,0]);
  const origin = projectPt(worldOrigin,cam,w,h);
  const gLen = clamp(0.55*cam.distance/3,0.18,1.6);
  const cpGLen = gLen * 0.6;
  let best=null, bestD=12;
  // CP axis arrows — compete with shape axes by proximity.
  for (const cp of cps) {
    const cpWorld = worldPointChain(ancestors, selNode, cp.pos);
    const cpScreen = projectPt(cpWorld, cam, w, h);
    if (!cpScreen) continue;
    for (const ax of AXES) {
      const end = projectPt(add3(cpWorld, scale3(ax.dir, cpGLen)), cam, w, h);
      if (!end) continue;
      const ox=cpScreen.x, oy=cpScreen.y, ex=end.x, ey=end.y;
      const dx=ex-ox, dy=ey-oy, lsq=dx*dx+dy*dy;
      if (!lsq) continue;
      const t=clamp(((mx-ox)*dx+(my-oy)*dy)/lsq,0,1);
      const d=Math.sqrt((mx-(ox+t*dx))**2+(my-(oy+t*dy))**2);
      if (d<bestD) { bestD=d; best=`cp:${cp.key}:${ax.id}`; }
    }
  }
  // Shape axes.
  if (!origin) return best;
  for (const ax of AXES) {
    const end = projectPt(add3(worldOrigin,scale3(ax.dir,gLen)),cam,w,h);
    if (!end) continue;
    const ox=origin.x, oy=origin.y, ex=end.x, ey=end.y;
    if (mode==='rotate') {
      const r=Math.sqrt((ex-ox)**2+(ey-oy)**2)*0.72;
      const d=Math.abs(Math.sqrt((mx-ox)**2+(my-oy)**2)-r);
      if (d<bestD) { bestD=d; best=ax.id; }
    } else {
      const dx=ex-ox, dy=ey-oy, lsq=dx*dx+dy*dy;
      if (!lsq) continue;
      const t=clamp(((mx-ox)*dx+(my-oy)*dy)/lsq,0,1);
      const d=Math.sqrt((mx-(ox+t*dx))**2+(my-(oy+t*dy))**2);
      if (d<bestD) { bestD=d; best=ax.id; }
    }
  }
  return best;
}

// ── Library Modal ─────────────────────────────────────────────────
// Manages the user SDF library: add GLSL entries, view/edit/delete entries,
// and instantiate them into the current scene.
function LibraryModal({ userLibrary, onSetUserLibrary, onAdd, onEdit, onClose }) {
  const [glslEditorOpen, setGlslEditorOpen] = useState(false);
  const [editingEntry, setEditingEntry]     = useState(null); // existing entry being GLSL-edited
  const [glslSrc, setGlslSrc]               = useState('');
  const [glslLabel, setGlslLabel]           = useState('');
  const [glslKind, setGlslKind]             = useState('dist');
  const [glslErr, setGlslErr]               = useState('');

  const openNewGlsl = () => {
    setEditingEntry(null);
    setGlslSrc('float sdMyShape(vec3 p, float radius) {\n  return length(p) - radius;\n}');
    setGlslLabel('');
    setGlslKind('dist');
    setGlslErr('');
    setGlslEditorOpen(true);
  };

  const openEditGlsl = (entry) => {
    setEditingEntry(entry);
    setGlslSrc(entry.glslSrc || '');
    setGlslLabel(entry.label);
    setGlslKind(entry.outputKind || 'dist');
    setGlslErr('');
    setGlslEditorOpen(true);
  };

  const saveGlsl = () => {
    if (editingEntry) {
      const updated = updateGlslLibraryEntry({ ...editingEntry, label: glslLabel || editingEntry.label, outputKind: glslKind }, glslSrc);
      if (!updated) { setGlslErr('Signature GLSL non reconnue.'); return; }
      onSetUserLibrary(lib => lib.map(e => e.id === editingEntry.id ? updated : e));
    } else {
      const entry = createGlslLibraryEntry(glslSrc, glslLabel, glslKind);
      if (!entry) { setGlslErr('Signature GLSL non reconnue (ex: float sdFoo(vec3 p, float r) {...}).'); return; }
      onSetUserLibrary(lib => [...lib, entry]);
    }
    setGlslEditorOpen(false);
  };

  const deleteEntry = (id) => {
    onSetUserLibrary(lib => lib.filter(e => e.id !== id));
  };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.75)', zIndex:100,
      display:'flex', alignItems:'center', justifyContent:'center' }} onClick={onClose}>
      <div style={{ background:'#13131a', border:`1px solid ${C.border2}`, borderRadius:8,
        width:600, maxHeight:'80vh', display:'flex', flexDirection:'column', padding:20 }}
        onClick={e=>e.stopPropagation()}>

        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
          <span style={{ color:'#fff', fontWeight:600, fontSize:13 }}>⊞ Bibliothèque SDF</span>
          <div style={{ display:'flex', gap:8 }}>
            <Btn onClick={openNewGlsl}>+ GLSL</Btn>
            <Btn onClick={onClose}>Fermer</Btn>
          </div>
        </div>

        {/* Built-in shapes (read-only) */}
        <div style={{ fontSize:9, color:C.dim, textTransform:'uppercase', letterSpacing:'.07em', marginBottom:4 }}>
          Primitives built-in
        </div>
        <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginBottom:12 }}>
          {SHAPE_TYPES.map(t=>(
            <span key={t} style={{ background:'rgba(119,153,255,.08)', border:`1px solid rgba(119,153,255,.2)`,
              borderRadius:3, padding:'2px 8px', fontSize:10, color:'#7799ff', fontFamily:'monospace' }}>
              {SHAPE_ICONS[t]} {SHAPE_LABELS[t]}
            </span>
          ))}
        </div>

        {/* User-defined entries */}
        <div style={{ fontSize:9, color:C.dim, textTransform:'uppercase', letterSpacing:'.07em', marginBottom:4 }}>
          User-defined ({userLibrary.length})
        </div>
        <div style={{ flex:1, overflowY:'auto' }}>
          {userLibrary.length === 0 && (
            <div style={{ padding:'14px 0', fontSize:11, color:C.dim, textAlign:'center' }}>
              Aucune entrée — ajoutez un SDF GLSL ou sauvegardez un groupe depuis la scène.
            </div>
          )}
          {userLibrary.map((entry, idx)=>(
            <div key={entry.id} style={{ display:'flex', alignItems:'center', gap:6,
              padding:'6px 8px', borderBottom:`1px solid ${C.border}`, borderRadius:3 }}>
              <span style={{ fontFamily:'monospace', fontSize:14, color:'#44ddcc', width:20 }}>{entry.icon||'◉'}</span>
              <span style={{ flex:1, fontSize:11, color:C.text }}>{entry.label}</span>
              <span style={{ fontSize:9, color:C.dim, padding:'1px 5px', background:'rgba(255,255,255,.04)',
                borderRadius:2, fontFamily:'monospace' }}>
                {entry.source === 'glsl' ? entry.outputKind : 'subtree'}
              </span>
              {entry.source === 'glsl' && (
                <Btn small onClick={()=>openEditGlsl(entry)}>Éditer GLSL</Btn>
              )}
              {entry.source === 'subtree' && (
                <Btn small onClick={()=>{ onEdit(idx); }}>Éditer</Btn>
              )}
              <Btn small onClick={()=>{ onAdd('library_ref', entry); onClose(); }}>
                + Scène
              </Btn>
              <button onClick={()=>deleteEntry(entry.id)}
                style={{ background:'rgba(255,60,80,.12)', color:'#ff6677', border:'none',
                  borderRadius:3, padding:'2px 6px', fontSize:10,
                  cursor:'pointer', fontFamily:'inherit' }}>✕</button>
            </div>
          ))}
        </div>

        {/* GLSL editor sub-panel */}
        {glslEditorOpen && (
          <div style={{ marginTop:12, borderTop:`1px solid ${C.border}`, paddingTop:12 }}>
            <div style={{ display:'flex', gap:8, marginBottom:8, alignItems:'center' }}>
              <input value={glslLabel} onChange={e=>setGlslLabel(e.target.value)}
                placeholder={editingEntry ? editingEntry.label : 'Nom'}
                style={{ flex:1, background:'#0d0d18', border:`1px solid ${C.border}`,
                  borderRadius:3, padding:'3px 7px', color:C.text, fontSize:11, fontFamily:'inherit' }}/>
              <select value={glslKind} onChange={e=>setGlslKind(e.target.value)}
                style={{ background:'#0d0d18', border:`1px solid ${C.border}`, borderRadius:3,
                  padding:'3px 7px', color:C.text, fontSize:11, fontFamily:'inherit' }}>
                <option value="dist">dist (float)</option>
                <option value="dist_k">dist_k (vec2: dist+k)</option>
                <option value="dist_mat">dist_mat (vec2: dist+matId)</option>
              </select>
            </div>
            <textarea value={glslSrc} onChange={e=>setGlslSrc(e.target.value)} rows={6}
              spellCheck={false}
              style={{ width:'100%', background:'#0a0a12', border:`1px solid ${C.border}`,
                borderRadius:3, padding:'6px 8px', color:'#b8d4ff', fontSize:10,
                fontFamily:'IBM Plex Mono,monospace', resize:'vertical' }}/>
            {glslErr && <div style={{ color:'#ff6677', fontSize:10, marginTop:4 }}>{glslErr}</div>}
            <div style={{ display:'flex', gap:8, marginTop:8 }}>
              <Btn onClick={saveGlsl} active>Valider</Btn>
              <Btn onClick={()=>setGlslEditorOpen(false)}>Annuler</Btn>
              <span style={{ fontSize:9, color:C.dim, marginLeft:4, alignSelf:'center' }}>
                Signature auto-parsée · premier paramètre vec3 = point
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Materials Modal ───────────────────────────────────────────────
// Palette editor: add, rename, recolor, tune reflection/roughness/spec.
// Deleting a material is disabled if any node still references it
// (tooltip reports the usage count); clear those assignments first.
function MaterialsModal({ palette, tree, onChange, onClose }) {
  const update = (id, patch) =>
    onChange(palette.map(m => m.id === id ? { ...m, ...patch } : m));
  const remove = id => onChange(palette.filter(m => m.id !== id));
  const add = () => onChange([...palette, makeMaterial(`Material ${palette.length+1}`, [.7,.7,.7])]);

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.75)', zIndex:100,
      display:'flex', alignItems:'center', justifyContent:'center' }} onClick={onClose}>
      <div style={{ background:'#13131a', border:`1px solid ${C.border2}`, borderRadius:8,
        width:640, maxHeight:'80vh', display:'flex', flexDirection:'column', padding:20 }}
        onClick={e=>e.stopPropagation()}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
          <span style={{ color:'#fff', fontWeight:600, fontSize:13 }}>Matériaux</span>
          <Btn onClick={onClose}>Fermer</Btn>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'20px 1fr 42px 70px 70px 70px 60px 24px',
          gap:6, alignItems:'center', fontSize:9, color:C.dim,
          textTransform:'uppercase', letterSpacing:'.06em',
          padding:'0 4px 6px', borderBottom:`1px solid ${C.border}` }}>
          <span></span>
          <span>Nom</span>
          <span style={{textAlign:'center'}}>Col.</span>
          <span style={{textAlign:'right'}}>Refl.</span>
          <span style={{textAlign:'right'}}>Rough.</span>
          <span style={{textAlign:'right'}}>Spec.</span>
          <span style={{textAlign:'right'}}>Pow.</span>
          <span></span>
        </div>
        <div style={{ flex:1, overflowY:'auto', padding:'6px 4px' }}>
          {palette.map(m => {
            const uses = isMaterialReferenced(tree, m.id);
            const canDelete = uses === 0;
            return (
              <div key={m.id} style={{ display:'grid',
                gridTemplateColumns:'20px 1fr 42px 70px 70px 70px 60px 24px',
                gap:6, alignItems:'center', padding:'5px 4px',
                borderBottom:`1px solid ${C.border}` }}>
                <span style={{ width:14, height:14, borderRadius:3, justifySelf:'center',
                  background:rgbToHex(m.color), border:`1px solid ${C.border2}` }}/>
                <input value={m.name} onChange={e=>update(m.id, {name:e.target.value})}
                  style={{ background:'#0d0d18', border:`1px solid ${C.border}`,
                    borderRadius:3, padding:'3px 6px', color:C.text,
                    fontSize:11, fontFamily:'inherit', width:'100%' }}/>
                <input type="color" value={rgbToHex(m.color)}
                  onChange={e=>update(m.id, {color:hexToRgb(e.target.value)})}
                  style={{ width:38, height:22, padding:0, border:`1px solid ${C.border}`,
                    borderRadius:3, background:'#0d0d18', cursor:'pointer' }}/>
                <NumInput value={m.refl}    step={0.02} min={0} max={1} width={60}
                  onChange={v=>update(m.id, {refl:clamp(v,0,1)})}/>
                <NumInput value={m.rough}   step={0.02} min={0} max={1} width={60}
                  onChange={v=>update(m.id, {rough:clamp(v,0,1)})}/>
                <NumInput value={m.spec}    step={0.02} min={0} max={1} width={60}
                  onChange={v=>update(m.id, {spec:clamp(v,0,1)})}/>
                <NumInput value={m.specPow} step={1}    min={1} max={256} width={50}
                  onChange={v=>update(m.id, {specPow:clamp(Math.round(v),1,256)})}/>
                <button onClick={()=>canDelete && remove(m.id)} disabled={!canDelete}
                  title={canDelete ? 'Supprimer' : `Utilisé par ${uses} nœud(s)`}
                  style={{ background:canDelete?'rgba(255,60,80,.12)':'transparent',
                    color:canDelete?'#ff6677':C.dim, border:'none',
                    borderRadius:3, padding:'2px 5px', fontSize:11,
                    cursor:canDelete?'pointer':'not-allowed', fontFamily:'inherit' }}>✕</button>
              </div>
            );
          })}
          {palette.length === 0 && (
            <div style={{ padding:'14px 4px', fontSize:11, color:C.dim, textAlign:'center' }}>
              Palette vide — ajoutez un matériau ci-dessous.
            </div>
          )}
        </div>
        <div style={{ paddingTop:10, display:'flex', gap:8, alignItems:'center' }}>
          <Btn onClick={add}>+ Ajouter</Btn>
          <span style={{ fontSize:10, color:C.dim }}>
            Les nœuds sans matériau héritent du group parent (fallback: premier matériau).
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Export Modal ──────────────────────────────────────────────────
function ExportModal({ code, onClose }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.75)', zIndex:100,
      display:'flex', alignItems:'center', justifyContent:'center' }} onClick={onClose}>
      <div style={{ background:'#13131a', border:`1px solid ${C.border2}`, borderRadius:8,
        width:720, maxHeight:'80vh', display:'flex', flexDirection:'column', padding:20 }}
        onClick={e=>e.stopPropagation()}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
          <span style={{ color:'#fff', fontWeight:600, fontSize:13 }}>Shadertoy Export</span>
          <div style={{ display:'flex', gap:8 }}>
            <Btn onClick={()=>{navigator.clipboard.writeText(code);setCopied(true);setTimeout(()=>setCopied(false),2000);}}>
              {copied?'✓ Copié !':'Copier tout'}
            </Btn>
            <Btn onClick={onClose}>Fermer</Btn>
          </div>
        </div>
        <div style={{ fontSize:10, color:C.dim, marginBottom:8 }}>
          Collez ce code dans <strong style={{color:C.text}}>shadertoy.com/new</strong> (remplacez l'éditeur entier)
        </div>
        <pre style={{ flex:1, overflowY:'auto', background:'#0a0a12', border:`1px solid ${C.border}`,
          borderRadius:4, padding:12, fontSize:10, color:'#b8d4ff',
          fontFamily:'IBM Plex Mono,monospace', whiteSpace:'pre-wrap', wordBreak:'break-all', margin:0 }}>
          {code}
        </pre>
      </div>
    </div>
  );
}

// ── Resize handle (vertical divider, col-resize) ─────────────────
function ResizeHandle({ onMouseDown }) {
  const [hov, setHov] = useState(false);
  return (
    <div onMouseDown={onMouseDown}
      onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)}
      style={{ width:4, cursor:'col-resize', flexShrink:0,
        background: hov ? C.acc : C.border, transition:'background .12s' }}/>
  );
}

// ── Toolbar mode buttons ──────────────────────────────────────────
const MODES = [
  { id:'translate', icon:'⊹', label:'Move (G)' },
  { id:'rotate',    icon:'↻', label:'Rotate (R)' },
  { id:'scale',     icon:'⤡', label:'Scale (S)' },
];

// ── Main App ──────────────────────────────────────────────────────
function App() {
  const _initProj = readAutosaveOnce();
  const [tree,       setTree]       = useState(() => _initProj?.tree || createDefaultScene());
  const [selId,      setSelId]      = useState(null);
  const [mode,       setMode]       = useState('translate');
  const [camera,     setCamera]     = useState(() => _initProj?.camera || { theta:0.65, phi:0.35, distance:3.2 });
  const [exportCode, setExportCode] = useState(null);
  const [hoverAxis,  setHoverAxis]  = useState(null);
  const [dropTarget, setDropTarget] = useState(null);  // { id, mode } | null
  const [leftW,      setLeftW]      = useState(235);
  const [rightW,     setRightW]     = useState(230);
  const [palette,      setPalette]      = useState(() => _initProj?.palette || DEFAULT_PALETTE);
  const [materialsOpen,setMaterialsOpen]= useState(false);
  const [bounces,      setBounces]      = useState(() => (typeof _initProj?.bounces === 'number') ? _initProj.bounces : 2);
  const [cameraParams, setCameraParams] = useState(() => _initProj?.cameraParams || { focusDistance: 3.2, focalLen: 2.8, aperture: 0.1 });
  const [userLibrary,  setUserLibrary]  = useState(() => _initProj?.userLibrary || []);
  const [libModalOpen, setLibModalOpen] = useState(false);
  // Library edit mode: swap scene tree for the entry's tree
  const [editingLibEntry, setEditingLibEntry] = useState(null); // { index } | null
  const originalSceneRef = useRef(null);
  const userLibraryRef   = useRef(userLibrary);
  useEffect(()=>{ userLibraryRef.current = userLibrary; }, [userLibrary]);
  const fileInputRef = useRef(null);

  const startResize = (side) => (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === 'left' ? leftW : rightW;
    const setter = side === 'left' ? setLeftW : setRightW;
    const sign   = side === 'left' ? 1 : -1;
    const move = ev => setter(clamp(startW + sign * (ev.clientX - startX), 180, 500));
    const up = () => { window.removeEventListener('mousemove',move); window.removeEventListener('mouseup',up); };
    window.addEventListener('mousemove',move); window.addEventListener('mouseup',up);
  };

  const rendererRef   = useRef(null);
  const glCanvasRef   = useRef(null);
  const gizmoCanvasRef= useRef(null);
  const vpDragRef     = useRef(null);   // viewport mouse drag (camera / gizmo)
  const treeDragId    = useRef(null);   // tree drag-and-drop
  const cameraRef     = useRef({ ...camera, focalLen: 1 });
  const fastPathRef   = useRef(false);  // last update touched only selected shape
  const prevSelIdRef  = useRef(null);
  // Merge camera state with focalLen so every projection/drag consumer picks
  // up the current zoom — projectPt reads cam.focalLen for the FOV factor.
  useEffect(()=>{ cameraRef.current = { ...camera, focalLen: cameraParams.focalLen }; }, [camera, cameraParams.focalLen]);

  // ── Undo / Redo ──────────────────────────────────────────────────
  // Snapshots of { tree, palette } — selection isn't tracked (it's a view
  // concern). History is debounced: during a drag we push only the state
  // BEFORE the drag started, then wait 400ms of quiet before committing.
  // That way a continuous NumInput/gizmo drag is a single undo step.
  const historyRef = useRef({
    past: [], future: [],
    lastCommitted: null,    // last state pushed (or baseline)
    pending: null,          // state to push when debounce fires
    debounce: null,
    suppress: false,        // true during undo/redo itself
    initialized: false,
  });
  const treeRef    = useRef(tree);
  const paletteRef = useRef(palette);
  useEffect(()=>{ treeRef.current = tree; }, [tree]);
  useEffect(()=>{ paletteRef.current = palette; }, [palette]);
  const [historyTick, setHistoryTick] = useState(0); // force re-render for buttons

  const commitPending = () => {
    const h = historyRef.current;
    if (!h.pending) return;
    h.past.push(h.pending);
    if (h.past.length > 200) h.past.shift();
    h.future = [];
    h.lastCommitted = { tree: treeRef.current, palette: paletteRef.current };
    h.pending = null;
    setHistoryTick(t => t + 1);
  };

  useEffect(()=>{
    const h = historyRef.current;
    if (!h.initialized) {
      h.initialized = true;
      h.lastCommitted = { tree, palette };
      return;
    }
    if (h.suppress) { h.suppress = false; return; }
    if (h.editMode) return; // no history tracking during library edit mode
    // First change in a burst — snapshot the PRE-change state.
    if (!h.pending) h.pending = h.lastCommitted;
    if (h.debounce) clearTimeout(h.debounce);
    h.debounce = setTimeout(commitPending, 400);
  }, [tree, palette]);

  const undo = useCallback(()=>{
    const h = historyRef.current;
    if (h.debounce) { clearTimeout(h.debounce); h.debounce = null; }
    commitPending(); // flush in-flight edit so undo goes to start-of-burst
    if (!h.past.length) return;
    const prev = h.past.pop();
    h.future.push(h.lastCommitted || { tree:treeRef.current, palette:paletteRef.current });
    h.lastCommitted = prev;
    h.suppress = true;
    setTree(prev.tree);
    setPalette(prev.palette);
    setHistoryTick(t => t + 1);
  }, []);

  const redo = useCallback(()=>{
    const h = historyRef.current;
    if (h.debounce) { clearTimeout(h.debounce); h.debounce = null; }
    commitPending();
    if (!h.future.length) return;
    const next = h.future.pop();
    h.past.push(h.lastCommitted || { tree:treeRef.current, palette:paletteRef.current });
    h.lastCommitted = next;
    h.suppress = true;
    setTree(next.tree);
    setPalette(next.palette);
    setHistoryTick(t => t + 1);
  }, []);

  const canUndo = !editingLibEntry && historyRef.current.past.length > 0;
  const canRedo = !editingLibEntry && historyRef.current.future.length > 0;

  // ── Library edit mode ────────────────────────────────────────────
  const enterLibraryEdit = useCallback((index) => {
    const entry = userLibraryRef.current[index];
    if (!entry || entry.source !== 'subtree') return;
    originalSceneRef.current = treeRef.current;
    historyRef.current.editMode = true;
    historyRef.current.suppress = true;
    setTree(deepCloneTree(entry.tree));
    setEditingLibEntry({ index });
    setSelId(null);
    setLibModalOpen(false);
  }, []);

  const exitLibraryEdit = useCallback((save) => {
    if (!editingLibEntry) return;
    if (save) {
      setUserLibrary(lib => {
        const newLib = [...lib];
        newLib[editingLibEntry.index] = { ...newLib[editingLibEntry.index], tree: deepCloneTree(treeRef.current) };
        return newLib;
      });
    }
    historyRef.current.editMode = false;
    historyRef.current.suppress = true;
    setTree(originalSceneRef.current);
    originalSceneRef.current = null;
    setEditingLibEntry(null);
    setSelId(null);
  }, [editingLibEntry]);

  // ── Save / Load / New ────────────────────────────────────────
  // Save: download JSON of current tree+palette+camera+bounces.
  // Load: JSON file picker; pushes current state to undo-history so it's recoverable.
  // New:  reset to default scene; clears history.
  // Autosave: localStorage, debounced 800ms on tree/palette/camera/bounces.
  const bouncesRef = useRef(bounces);
  useEffect(()=>{ bouncesRef.current = bounces; }, [bounces]);
  const cameraParamsRef = useRef(cameraParams);
  useEffect(()=>{ cameraParamsRef.current = cameraParams; }, [cameraParams]);

  const saveProject = useCallback(() => {
    const data = serializeProject(treeRef.current, paletteRef.current, cameraRef.current, bouncesRef.current, cameraParamsRef.current, userLibraryRef.current);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    a.download = `sdf-scene-${ts}.json`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  const applyLoadedProject = useCallback((p, { undoable = true } = {}) => {
    const h = historyRef.current;
    if (h.debounce) { clearTimeout(h.debounce); h.debounce = null; }
    if (h.pending) { // flush any in-flight edit
      h.past.push(h.pending); h.pending = null;
      if (h.past.length > 200) h.past.shift();
    }
    if (undoable) {
      h.past.push(h.lastCommitted || { tree:treeRef.current, palette:paletteRef.current });
      if (h.past.length > 200) h.past.shift();
    } else {
      h.past = [];
    }
    h.future = [];
    h.lastCommitted = { tree: p.tree, palette: p.palette };
    h.suppress = true;
    h.editMode = false;
    setTree(p.tree);
    setPalette(p.palette);
    if (p.camera) setCamera(p.camera);
    if (typeof p.bounces === 'number') setBounces(clamp(Math.round(p.bounces), 1, 5));
    if (p.cameraParams) setCameraParams(p.cameraParams);
    if (Array.isArray(p.userLibrary)) setUserLibrary(p.userLibrary);
    setEditingLibEntry(null);
    setSelId(null);
    setHistoryTick(t => t + 1);
  }, []);

  const loadProject = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onProjectFileChosen = useCallback((e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;
    const r = new FileReader();
    r.onload = ev => {
      try {
        const p = JSON.parse(String(ev.target.result));
        if (!isValidProject(p)) { alert('Fichier projet invalide (format non reconnu).'); return; }
        applyLoadedProject(p, { undoable: true });
      } catch (err) {
        alert('Erreur de lecture : ' + err.message);
      }
    };
    r.readAsText(file);
  }, [applyLoadedProject]);

  const newProject = useCallback(() => {
    if (!window.confirm('Nouvelle scène ? Les changements non sauvegardés seront perdus.')) return;
    applyLoadedProject(
      { tree: createDefaultScene(), palette: DEFAULT_PALETTE, camera: { theta:0.65, phi:0.35, distance:3.2 }, bounces: 2, cameraParams: { focusDistance: 3.2, focalLen: 2.8, aperture: 0.1 } },
      { undoable: false }
    );
  }, [applyLoadedProject]);

  // Autosave (debounced) — disabled during library edit mode
  useEffect(() => {
    if (editingLibEntry) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY,
          JSON.stringify(serializeProject(tree, palette, camera, bounces, cameraParams, userLibrary)));
      } catch {}
    }, 800);
    return () => clearTimeout(t);
  }, [tree, palette, camera, bounces, cameraParams, userLibrary, editingLibEntry]);

  const selNode = useMemo(()=> selId ? findNode(tree, selId) : null, [tree, selId]);
  // Ancestor chain of the selected node — lets the gizmo match the compiled transform stack.
  const selAncestors = useMemo(
    () => (selId ? (getAncestors(tree, selId) || []) : []),
    [tree, selId]
  );

  // Boot renderer
  useEffect(()=>{
    const r = new SDFRenderer(glCanvasRef.current);
    r.setCameraParams(cameraParams);
    rendererRef.current = r;
    return ()=>r.destroy();
  }, []);

  // Sync renderer with tree/selection/palette. Two fast paths avoid the
  // shader recompile:
  //  1. `fastPathRef` — only the selected node's live uniforms changed.
  //  2. palette-only change — push `u_matCol[]`/`u_matMat[]` uniforms,
  //     no structural edits → keeps color-picker drags at 60 fps.
  const prevPaletteRef = useRef(palette);
  const prevTreeRef    = useRef(tree);
  useEffect(()=>{
    const r = rendererRef.current; if(!r) return;
    const selChanged     = prevSelIdRef.current !== selId;
    const paletteChanged = prevPaletteRef.current !== palette;
    const treeChanged    = prevTreeRef.current !== tree;
    prevSelIdRef.current = selId;
    prevPaletteRef.current = palette;
    prevTreeRef.current = tree;
    if (fastPathRef.current && !selChanged && !paletteChanged) {
      fastPathRef.current = false;
      r.updateSelectedData(selNode);
      return;
    }
    fastPathRef.current = false;
    if (paletteChanged && !treeChanged && !selChanged) {
      r.updateMaterials(tree, palette);
      return;
    }
    r.setSelection(selNode);
    r.updateScene(tree, palette, userLibrary);
  }, [tree, selId, palette, userLibrary]);

  // Selection highlight — disabled. Phase 1 switched shapeCol/shapeMat to
  // material IDs, so the shader's `firstHitMat` no longer identifies a
  // single shape. The gizmo + tree highlight already make the selection
  // obvious; skipping the shader-side tint removes a recompile bump.
  useEffect(()=>{
    const r = rendererRef.current;
    if (r) r.selMat = -1;
  }, [selId, tree]);

  // Sync camera
  useEffect(()=>{
    if (rendererRef.current) rendererRef.current.camera = {...camera};
  }, [camera]);

  // Bounces recompiles the shader (BOUNCE is baked as a #define) and resets
  // the accumulator — handled internally by setBounces.
  useEffect(()=>{
    if (rendererRef.current) rendererRef.current.setBounces(bounces);
  }, [bounces]);

  // Live camera params → renderer (focusDistance / focalLen / aperture).
  useEffect(()=>{
    if (rendererRef.current) rendererRef.current.setCameraParams(cameraParams);
  }, [cameraParams]);

  // Draw gizmo every frame
  useEffect(()=>{
    const cvs = gizmoCanvasRef.current; if(!cvs) return;
    const ctx = cvs.getContext('2d');
    const w=cvs.clientWidth, h=cvs.clientHeight;
    cvs.width=w; cvs.height=h;
    drawGizmo(ctx, selNode, selAncestors, mode, hoverAxis, { ...camera, focalLen: cameraParams.focalLen }, w, h);
  });

  // Keyboard shortcuts
  useEffect(()=>{
    const h = e => {
      // Any form control steals our shortcuts — including TEXTAREA used by
      // the Advanced GLSL inputs (pTransform/dTransform/profile).
      const tag = e.target.tagName;
      if (tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA'||e.target.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key==='z' || e.key==='Z')) {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (mod && (e.key==='y' || e.key==='Y')) { e.preventDefault(); redo(); return; }
      if (mod && (e.key==='s' || e.key==='S')) { e.preventDefault(); saveProject(); return; }
      if (mod && (e.key==='o' || e.key==='O')) { e.preventDefault(); loadProject(); return; }
      if (e.key==='g') setMode('translate');
      if (e.key==='r') setMode('rotate');
      if (e.key==='s') setMode('scale');
      if (e.key==='Escape') setSelId(null);
      if ((e.key==='Delete'||e.key==='Backspace') && selId) deleteNode(selId);
    };
    window.addEventListener('keydown',h);
    return ()=>window.removeEventListener('keydown',h);
  }, [selId]);

  // ── Tree operations ──────────────────────────────────────────────
  const updateNode = useCallback((id, updates) => {
    // Fast path marker: the selected node's transform / shape params are
    // bound to uniforms, so changes to them don't need a shader recompile.
    // Skip the marker for:
    //   - structural updates (type/children/materialId)
    //   - GLSL text fields (pTransform/dTransform, params.profile) which
    //     are inlined into the shader
    //   - repeat_angular.axis which is baked as GLSL swizzles
    const hasStructural = 'type' in updates || 'children' in updates || 'materialId' in updates;
    const hasGlslText   = 'pTransform' in updates || 'dTransform' in updates
                       || (updates.params && 'profile' in updates.params);
    if (id === selId && !hasStructural && !hasGlslText) {
      const sel = findNode(tree, id);
      const axisBaked = sel && sel.type === 'repeat_angular'
                    && updates.params && 'axis' in updates.params
                    && updates.params.axis !== sel.params.axis;
      if (!axisBaked) fastPathRef.current = true;
    }
    setTree(t => mapTree(t, n => n.id===id ? {...n,...updates} : n));
  }, [selId, tree]);

  const deleteNode = useCallback((id) => {
    setTree(t => t.id===id ? createDefaultScene() : removeFromTree(t, id));
    setSelId(s => s===id ? null : s);
  }, []);

  // addNode: type = shape/op/modifier or 'library_ref'
  // When type === 'library_ref', parentId is the library entry object
  const addNode = useCallback((type, parentId) => {
    // library_ref: parentId is actually the library entry
    const newNode = (type === 'library_ref')
      ? createLibraryRef(parentId)
      : createNode(type);
    const explicitParentId = (type === 'library_ref') ? null : parentId;
    setTree(t => {
      // 1. Explicit parent given → insert as child of that node
      if (explicitParentId) {
        const par = findNode(t, explicitParentId);
        if (par && isGroupType(par.type)) {
          return insertChild(t, explicitParentId, newNode);
        }
      }
      // 2. Selected node is a group → insert as child
      if (selId) {
        const sel = findNode(t, selId);
        if (sel && isGroupType(sel.type)) {
          return insertChild(t, selId, newNode);
        }
        // Selected node is a shape/ref → insert as sibling (child of its parent group)
        if (sel && (SHAPE_TYPES.includes(sel.type) || sel.type === 'library_ref')) {
          const par = findParent(t, selId);
          if (par && isGroupType(par.type)) {
            return insertChild(t, par.id, newNode);
          }
        }
      }
      // 3. Root is a group → insert at root level
      if (isGroupType(t.type)) {
        return insertChild(t, t.id, newNode);
      }
      // 4. Fallback: wrap root + new in a union
      const wrapper = createNode('union');
      wrapper.children = [t, newNode];
      return wrapper;
    });
    setSelId(newNode.id);
  }, [selId]);

  const wrapNode = useCallback((id, opType) => {
    setTree(t => mapTree(t, n => {
      if (n.id===id) {
        const w = createNode(opType);
        w.children = [{...n, children: n.children||[]}];
        return w;
      }
      return n;
    }));
  }, []);

  // ── Viewport mouse handling ──────────────────────────────────────
  const handleMouseDown = useCallback((e) => {
    const cvs = gizmoCanvasRef.current;
    const rect = cvs.getBoundingClientRect();
    const mx=e.clientX-rect.left, my=e.clientY-rect.top;
    const w=rect.width, h=rect.height;
    const hit = hitTestGizmo(mx,my,selNode,selAncestors,mode,cameraRef.current,w,h);
    if (hit && selNode) {
      e.preventDefault();
      if (hit.startsWith('cp:')) {
        // Control-point drag (capsule A/B, bezier P0/P1/P2).
        // Hit format: 'cp:<key>' for free drag, 'cp:<key>:<axis>' for constrained.
        const parts = hit.split(':');
        const key = parts[1];
        const cpAxis = parts[2] || null;  // 'x'|'y'|'z' or null for free drag
        const localCp = [...(selNode.params?.[key] || [0,0,0])];
        const worldCp = worldPointChain(selAncestors, selNode, localCp);
        const screen = projectPt(worldCp, cameraRef.current, w, h);
        vpDragRef.current = {
          type:'cp', cpKey:key, cpAxis, h,
          startMouse:[e.clientX,e.clientY],
          startCp:localCp,
          ancestors:selAncestors,
          nodeSnapshot:{ rotation:[...(selNode.rotation||[0,0,0])], scale:(typeof selNode.scale==='number')?selNode.scale:1 },
          depth: screen ? screen.depth : cameraRef.current.distance,
          nodeId:selNode.id,
        };
      } else {
        vpDragRef.current = {
          type:'gizmo', axis:hit, h,
          startMouse:[e.clientX,e.clientY],
          startPos:[...(selNode.position||[0,0,0])],
          startRot:[...(selNode.rotation||[0,0,0])],
          startSc:(typeof selNode.scale==='number')?selNode.scale:1,
          ancestors:selAncestors,
          nodeId:selNode.id,
        };
      }
    } else {
      vpDragRef.current = {
        type:'camera',
        startMouse:[e.clientX,e.clientY],
        startTheta:cameraRef.current.theta,
        startPhi:cameraRef.current.phi,
      };
    }
  }, [selNode, selAncestors, mode]);

  const handleMouseMove = useCallback((e) => {
    const d = vpDragRef.current;
    if (!d) {
      // Hover detection
      const cvs=gizmoCanvasRef.current; if(!cvs) return;
      const rect=cvs.getBoundingClientRect();
      setHoverAxis(hitTestGizmo(e.clientX-rect.left, e.clientY-rect.top, selNode, selAncestors, mode, cameraRef.current, rect.width, rect.height));
      return;
    }
    if (d.type==='camera') {
      const dx=e.clientX-d.startMouse[0], dy=e.clientY-d.startMouse[1];
      setCamera(c=>({...c,
        theta:d.startTheta-dx*0.006,
        phi:clamp(d.startPhi+dy*0.006,-Math.PI/2+0.05,Math.PI/2-0.05),
      }));
    } else if (d.type==='gizmo') {
      const cam=cameraRef.current;
      const {right,up}=getCamVecs(cam);
      const fL=cam.focalLen||1;
      const dx=e.clientX-d.startMouse[0], dy=e.clientY-d.startMouse[1];
      const axDir=d.axis==='x'?[1,0,0]:d.axis==='y'?[0,1,0]:[0,0,1];
      if (mode==='translate') {
        // Drag produces a world-space delta; project back into the parent frame
        // (where selNode.position lives) by peeling off every ancestor's transform.
        const delta=dragAxisDelta(dx,dy,axDir,right,up,cam.distance/(d.h*fL));
        const worldD=scale3(axDir,delta);
        const parentD=ancestorsInverseDelta(d.ancestors, worldD);
        updateNode(d.nodeId,{position:d.startPos.map((v,i)=>v+parentD[i])});
      } else if (mode==='rotate') {
        const proj=(dx*dot3(axDir,right) - dy*dot3(axDir,up))*0.012;
        const idx=d.axis==='x'?0:d.axis==='y'?1:2;
        const nr=[...d.startRot]; nr[idx]=d.startRot[idx]+proj;
        updateNode(d.nodeId,{rotation:nr});
      } else if (mode==='scale') {
        const factor=1+dragAxisDelta(dx,dy,axDir,right,up,cam.distance/(d.h*fL))*1.5;
        updateNode(d.nodeId,{scale:Math.max(0.01, d.startSc*factor)});
      }
    } else if (d.type==='cp') {
      // Control-point drag: either free (camera-plane) or axis-constrained.
      // World delta is inverted through the FULL ancestor chain + node transform
      // to get the delta in the node's local frame (where cp.pos is stored).
      const cam=cameraRef.current;
      const {right,up}=getCamVecs(cam);
      const fL=cam.focalLen||1;
      const dx=e.clientX-d.startMouse[0], dy=e.clientY-d.startMouse[1];
      let worldD;
      if (d.cpAxis) {
        const axDir=d.cpAxis==='x'?[1,0,0]:d.cpAxis==='y'?[0,1,0]:[0,0,1];
        const delta=dragAxisDelta(dx,dy,axDir,right,up,cam.distance/(d.h*fL));
        worldD=scale3(axDir,delta);
      } else {
        const s=d.depth/(d.h*fL);
        worldD=add3(scale3(right,dx*s),scale3(up,-dy*s));
      }
      const localD=localDeltaChain(d.ancestors, d.nodeSnapshot, worldD);
      const newCp=[
        d.startCp[0]+localD[0],
        d.startCp[1]+localD[1],
        d.startCp[2]+localD[2],
      ];
      fastPathRef.current=true;
      setTree(t=>mapTree(t,n=>
        n.id===d.nodeId?{...n,params:{...n.params,[d.cpKey]:newCp}}:n
      ));
    }
  }, [selNode, selAncestors, mode, updateNode]);

  const handleMouseUp = useCallback(()=>{ vpDragRef.current=null; }, []);
  const handleWheel = useCallback((e)=>{
    e.preventDefault();
    setCamera(c=>({...c,distance:clamp(c.distance*(1+e.deltaY*0.001),0.3,20)}));
  }, []);

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', background:C.bg, overflow:'hidden' }}>

      {/* ── Toolbar ── */}
      <div style={{ height:42, background:C.panel, borderBottom:`1px solid ${C.border}`,
        display:'flex', alignItems:'center', gap:8, padding:'0 12px', flexShrink:0 }}>
        <span style={{ color:'#fff', fontWeight:700, fontSize:13, marginRight:8 }}>
          <span style={{color:C.acc}}>SDF</span> Editor
        </span>
        <div style={{ width:1, height:20, background:C.border }}/>
        {MODES.map(m=>(
          <Btn key={m.id} active={mode===m.id} onClick={()=>setMode(m.id)} title={m.label}>
            <span style={{marginRight:5}}>{m.icon}</span>{m.id.charAt(0).toUpperCase()+m.id.slice(1)}
          </Btn>
        ))}
        <div style={{ width:1, height:20, background:C.border }}/>
        <Btn onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">↶ Undo</Btn>
        <Btn onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z / Ctrl+Y)">↷ Redo</Btn>
        <div style={{ flex:1 }}/>
        <div style={{ display:'flex', alignItems:'center', gap:5 }} title="Path-tracer bounce count (preview + export)">
          <span style={{ fontSize:10, color:C.dim }}>Bounces</span>
          <NumInput value={bounces} step={1} min={1} max={5} width={34}
            onChange={v=>setBounces(Math.max(1, Math.min(5, Math.round(v))))}/>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:5 }} title="Focus distance for depth of field">
          <span style={{ fontSize:10, color:C.dim }}>Focus</span>
          <NumInput value={cameraParams.focusDistance} step={0.1} min={0.1} max={20} width={40}
            onChange={v=>setCameraParams({...cameraParams, focusDistance:v})}/>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:5 }} title="Focal length">
          <span style={{ fontSize:10, color:C.dim }}>Focal</span>
          <NumInput value={cameraParams.focalLen} step={0.1} min={0.5} max={10} width={40}
            onChange={v=>setCameraParams({...cameraParams, focalLen:v})}/>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:5 }} title="Aperture (depth of field blur)">
          <span style={{ fontSize:10, color:C.dim }}>Aper.</span>
          <NumInput value={cameraParams.aperture} step={0.01} min={0} max={1} width={40}
            onChange={v=>setCameraParams({...cameraParams, aperture:v})}/>
        </div>
        <div style={{ width:1, height:20, background:C.border }}/>
        <Btn onClick={newProject} title="Nouvelle scène">✦ New</Btn>
        <Btn onClick={loadProject} title="Charger un projet (.json)">⤒ Load</Btn>
        <Btn onClick={saveProject} title="Sauvegarder le projet (Ctrl+S)">⤓ Save</Btn>
        <input ref={fileInputRef} type="file" accept="application/json,.json"
          onChange={onProjectFileChosen} style={{ display:'none' }}/>
        <div style={{ width:1, height:20, background:C.border }}/>
        <Btn onClick={()=>setMaterialsOpen(true)} title="Éditer la palette">◆ Matériaux</Btn>
        <Btn onClick={()=>setLibModalOpen(true)} title="Bibliothèque SDF">⊞ Bibliothèque</Btn>
        <Btn onClick={()=>setExportCode(exportShadertoyPathTraced(tree, palette, bounces, cameraParams, userLibrary))}
          title="Export path-traced multi-pass Shadertoy">↗ Shadertoy</Btn>
      </div>

      {/* ── Library edit mode banner ── */}
      {editingLibEntry && (
        <div style={{ background:'#1a2820', borderBottom:`1px solid #44ddcc40`,
          padding:'5px 14px', display:'flex', alignItems:'center', gap:10, flexShrink:0 }}>
          <span style={{ color:'#44ddcc', fontSize:11, fontWeight:600 }}>
            Édition bibliothèque : {userLibrary[editingLibEntry.index]?.label}
          </span>
          <span style={{ flex:1 }}/>
          <Btn onClick={()=>exitLibraryEdit(false)}>Annuler</Btn>
          <Btn active onClick={()=>exitLibraryEdit(true)}>✓ Terminer</Btn>
        </div>
      )}

      {/* ── Body ── */}
      <div style={{ flex:1, display:'flex', minHeight:0 }}>

        {/* ── Left panel ── */}
        <div style={{ width:leftW, background:C.panel, borderRight:`1px solid ${C.border}`,
          display:'flex', flexDirection:'column', flexShrink:0 }}>

          {/* Tree header */}
          <div style={{ padding:'7px 10px', borderBottom:`1px solid ${C.border}`,
            display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <span style={{ fontSize:10, color:C.dim, textTransform:'uppercase', letterSpacing:'.08em' }}>Objets</span>
            <PopupMenu trigger={(open,toggle)=>(
              <button onClick={toggle}
                style={{ background:open?C.acc:'transparent', color:open?'#fff':C.text,
                  border:`1px solid ${open?C.acc:C.border}`, borderRadius:4,
                  padding:'3px 10px', fontSize:11, cursor:'pointer', fontFamily:'inherit' }}>
                + Add
              </button>
            )}>
              {close=><AddMenuContent onAdd={addNode} close={close} userLibrary={userLibrary}/>}
            </PopupMenu>
          </div>

          {/* Tree */}
          <div style={{ flex:1, overflowY:'auto' }}
            onDragOver={e=>e.preventDefault()}
            onDragLeave={e=>{ if(e.currentTarget===e.target) setDropTarget(null); }}
            onDrop={e=>{ e.preventDefault(); setDropTarget(null); }}>
            <TreeItem node={tree} depth={0} isRoot selectedId={selId}
              onSelect={setSelId}
              onAdd={addNode}
              onDelete={deleteNode}
              dropTarget={dropTarget}
              onDragStart={id=>{ treeDragId.current=id; }}
              onDragOver={(id, mode)=>{
                setDropTarget(prev => (prev && prev.id===id && prev.mode===mode) ? prev : { id, mode });
              }}
              onDrop={(targetId, mode)=>{
                const dragId = treeDragId.current;
                if (dragId && dragId !== targetId) {
                  setTree(t=>moveNodeAt(t, dragId, targetId, mode));
                }
                treeDragId.current=null;
                setDropTarget(null);
              }}
            />
          </div>

          {/* Wrap in modifier — op wrappers are pointless on a single node */}
          {selId && (() => {
            const selN = findNode(tree, selId);
            const isSelGroup = selN && isGroupType(selN.type);
            return (
              <div style={{ padding:'8px 10px', borderTop:`1px solid ${C.border}` }}>
                <div style={{ fontSize:10, color:C.dim, marginBottom:5, textTransform:'uppercase', letterSpacing:'.06em' }}>
                  Encapsuler dans…
                </div>
                <div style={{ display:'flex', flexWrap:'wrap', gap:3 }}>
                  {MODIFIER_TYPES.map(t=>(
                    <button key={t} onClick={()=>wrapNode(selId,t)} title={MODIFIER_LABELS[t]}
                      style={{ background:'rgba(255,255,255,.05)', color:'#bb88ff', border:`1px solid ${C.border}`,
                        borderRadius:3, padding:'2px 7px', fontSize:10, cursor:'pointer', fontFamily:'monospace' }}>
                      {MODIFIER_ICONS[t]} {MODIFIER_LABELS[t]}
                    </button>
                  ))}
                </div>
                {isSelGroup && !editingLibEntry && (
                  <button onClick={()=>{
                    const label = window.prompt('Nom de l\'objet dans la bibliothèque', selN.name || 'Prefab');
                    if (!label) return;
                    const entry = libraryEntryFromSubtree(selN, label);
                    setUserLibrary(lib => [...lib, entry]);
                    // Replace node in tree with a library_ref
                    const ref = createLibraryRef(entry);
                    setTree(t => mapTree(t, n => n.id === selId ? ref : n));
                    setSelId(ref.id);
                  }}
                    style={{ marginTop:6, width:'100%', background:'rgba(68,221,204,.08)',
                      color:'#44ddcc', border:`1px solid rgba(68,221,204,.3)`,
                      borderRadius:3, padding:'3px 0', fontSize:10, cursor:'pointer', fontFamily:'inherit' }}>
                    ⬟ Sauvegarder en bibliothèque
                  </button>
                )}
              </div>
            );
          })()}
        </div>

        {/* ── Left resize handle ── */}
        <ResizeHandle onMouseDown={startResize('left')} />

        {/* ── Viewport ── */}
        <div style={{ flex:1, position:'relative', overflow:'hidden', minWidth:200 }} onWheel={handleWheel}>
          <canvas ref={glCanvasRef} style={{ position:'absolute', inset:0, width:'100%', height:'100%' }}/>
          <canvas ref={gizmoCanvasRef} style={{ position:'absolute', inset:0, width:'100%', height:'100%', pointerEvents:'none' }}/>
          {/* Event capture */}
          <div style={{ position:'absolute', inset:0 }}
            onMouseDown={handleMouseDown} onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}/>
          {/* Status bar */}
          <div style={{ position:'absolute', bottom:12, left:'50%', transform:'translateX(-50%)',
            background:'rgba(10,10,20,.78)', border:`1px solid ${C.border2}`, borderRadius:20,
            padding:'4px 14px', fontSize:10, color:C.dim, pointerEvents:'none' }}>
            <span style={{color:C.text}}>{MODES.find(m=>m.id===mode)?.icon}</span>
            <span style={{marginLeft:6}}>{MODES.find(m=>m.id===mode)?.label}</span>
            <span style={{marginLeft:10, opacity:.45}}>Alt+drag orbit · Scroll zoom</span>
          </div>
          {!selId && (
            <div style={{ position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)',
              color:C.dim, fontSize:11, pointerEvents:'none', opacity:.35, textAlign:'center' }}>
              Cliquez un objet dans l'arbre pour le sélectionner
            </div>
          )}
        </div>

        {/* ── Right resize handle ── */}
        <ResizeHandle onMouseDown={startResize('right')} />

        {/* ── Right panel (properties) ── */}
        <div style={{ width:rightW, background:C.panel, borderLeft:`1px solid ${C.border}`,
          display:'flex', flexDirection:'column', flexShrink:0 }}>
          <div style={{ padding:'7px 10px', borderBottom:`1px solid ${C.border}` }}>
            <span style={{ fontSize:10, color:C.dim, textTransform:'uppercase', letterSpacing:'.08em' }}>Propriétés</span>
          </div>
          <PropsPanel node={selNode}
            onChange={updates=>updateNode(selNode.id, updates)}
            palette={palette}
            tree={tree}
            isRoot={selNode && selNode.id === tree.id}
            onOpenMaterials={()=>setMaterialsOpen(true)}
            userLibrary={userLibrary}
            onEditLibrary={entry=>{
              const idx = userLibrary.findIndex(e => e.id === entry.id);
              if (idx < 0) return;
              if (entry.source === 'subtree') enterLibraryEdit(idx);
              else setLibModalOpen(true);
            }} />
        </div>
      </div>

      {exportCode && <ExportModal code={exportCode} onClose={()=>setExportCode(null)}/>}
      {materialsOpen && <MaterialsModal palette={palette} tree={tree}
        onChange={setPalette} onClose={()=>setMaterialsOpen(false)}/>}
      {libModalOpen && (
        <LibraryModal
          userLibrary={userLibrary}
          onSetUserLibrary={setUserLibrary}
          onAdd={addNode}
          onEdit={enterLibraryEdit}
          onClose={()=>setLibModalOpen(false)}
        />
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
