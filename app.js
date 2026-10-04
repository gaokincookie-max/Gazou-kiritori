(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const overlay = $('overlay');
  const stage = $('stage');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const octx = overlay.getContext('2d');

  const state = {
    image: null,
    original: null,
    mask: null,
    previewMask: null,
    tool: 'pan',
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    drawing: false,
    panning: false,
    lastPoint: null,
    startPoint: null,
    polygon: [],
    pickMode: false,
    spaceDown: false,
    history: [],
    future: [],
  };

  const MAX_HISTORY = 30;

  function setStatus(text) { $('statusText').textContent = text; }
  function setEnabled(enabled) {
    ['exportBtn','undoBtn','redoBtn','resetBtn','previewChromaBtn','applyChromaBtn'].forEach(id => {
      $(id).disabled = !enabled;
    });
    updateHistoryButtons();
  }
  function updateHistoryButtons() {
    $('undoBtn').disabled = !state.image || state.history.length === 0;
    $('redoBtn').disabled = !state.image || state.future.length === 0;
  }

  function fitImage() {
    if (!state.image) return;
    const rect = stage.getBoundingClientRect();
    const z = Math.min((rect.width - 40) / state.image.width, (rect.height - 40) / state.image.height, 1);
    state.zoom = Math.max(0.1, z);
    state.offsetX = (rect.width - state.image.width * state.zoom) / 2;
    state.offsetY = (rect.height - state.image.height * state.zoom) / 2;
    $('zoomSlider').value = Math.round(state.zoom * 100);
    $('zoomValue').textContent = Math.round(state.zoom * 100);
    render();
  }

  function loadImage(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        state.image = img;
        const off = document.createElement('canvas');
        off.width = img.naturalWidth;
        off.height = img.naturalHeight;
        const oc = off.getContext('2d', { willReadFrequently: true });
        oc.drawImage(img, 0, 0);
        state.original = oc.getImageData(0, 0, off.width, off.height);
        state.mask = new Uint8ClampedArray(off.width * off.height);
        state.mask.fill(255);
        state.previewMask = null;
        state.history = [];
        state.future = [];
        state.polygon = [];
        canvas.width = overlay.width = off.width;
        canvas.height = overlay.height = off.height;
        $('dropHint').classList.add('hidden');
        $('imageInfo').textContent = `${off.width} × ${off.height}`;
        setEnabled(true);
        fitImage();
        setStatus('画像を読み込みました');
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function snapshot() {
    state.history.push(state.mask.slice());
    if (state.history.length > MAX_HISTORY) state.history.shift();
    state.future = [];
    updateHistoryButtons();
  }

  function undo() {
    if (!state.history.length) return;
    state.future.push(state.mask.slice());
    state.mask = state.history.pop();
    state.previewMask = null;
    updateHistoryButtons();
    render();
  }
  function redo() {
    if (!state.future.length) return;
    state.history.push(state.mask.slice());
    state.mask = state.future.pop();
    state.previewMask = null;
    updateHistoryButtons();
    render();
  }

  function render() {
    if (!state.image || !state.original || !state.mask) return;
    const mask = state.previewMask || state.mask;
    const out = new ImageData(new Uint8ClampedArray(state.original.data), state.original.width, state.original.height);
    const showMask = $('maskToggle').checked;
    for (let i = 0, p = 0; i < out.data.length; i += 4, p++) {
      const a = Math.round(out.data[i + 3] * mask[p] / 255);
      out.data[i + 3] = a;
      if (showMask && mask[p] < 255) {
        out.data[i] = Math.min(255, out.data[i] * 0.45 + 180);
        out.data[i + 1] *= 0.35;
        out.data[i + 2] *= 0.35;
        out.data[i + 3] = Math.max(a, 145);
      }
    }
    ctx.putImageData(out, 0, 0);
    applyTransform();
    drawOverlay();
  }

  function applyTransform() {
    const cssW = state.image.width * state.zoom;
    const cssH = state.image.height * state.zoom;
    for (const c of [canvas, overlay]) {
      c.style.width = `${cssW}px`;
      c.style.height = `${cssH}px`;
      c.style.left = `${state.offsetX}px`;
      c.style.top = `${state.offsetY}px`;
    }
  }

  function drawOverlay(extraPoint = null) {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    octx.save();
    octx.lineWidth = Math.max(1, 1.5 / state.zoom);
    octx.strokeStyle = '#74a7ff';
    octx.fillStyle = 'rgba(80,130,255,.15)';
    if (state.tool === 'polygon' && state.polygon.length) {
      octx.beginPath();
      octx.moveTo(state.polygon[0].x, state.polygon[0].y);
      for (let i = 1; i < state.polygon.length; i++) octx.lineTo(state.polygon[i].x, state.polygon[i].y);
      if (extraPoint) octx.lineTo(extraPoint.x, extraPoint.y);
      octx.stroke();
      for (const p of state.polygon) {
        octx.beginPath(); octx.arc(p.x,p.y,4/state.zoom,0,Math.PI*2); octx.fill(); octx.stroke();
      }
    }
    octx.restore();
  }

  function stageToImage(clientX, clientY) {
    const r = stage.getBoundingClientRect();
    return {
      x: (clientX - r.left - state.offsetX) / state.zoom,
      y: (clientY - r.top - state.offsetY) / state.zoom,
    };
  }
  function insideImage(p) {
    return state.image && p.x >= 0 && p.y >= 0 && p.x < state.image.width && p.y < state.image.height;
  }

  function paintLine(a, b, mode) {
    const size = +$('brushSize').value;
    const hardness = +$('brushHardness').value / 100;
    const minX = Math.floor(Math.min(a.x, b.x) - size);
    const maxX = Math.ceil(Math.max(a.x, b.x) + size);
    const minY = Math.floor(Math.min(a.y, b.y) - size);
    const maxY = Math.ceil(Math.max(a.y, b.y) + size);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx*dx + dy*dy || 1;
    const radius = size / 2;
    const inner = radius * hardness;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      if (x < 0 || y < 0 || x >= state.image.width || y >= state.image.height) continue;
      const t = Math.max(0, Math.min(1, ((x-a.x)*dx + (y-a.y)*dy)/len2));
      const qx = a.x + t*dx, qy = a.y + t*dy;
      const d = Math.hypot(x-qx, y-qy);
      if (d > radius) continue;
      const feather = radius <= inner ? 1 : Math.max(0, Math.min(1, (radius-d)/(radius-inner)));
      const idx = y * state.image.width + x;
      if (mode === 'erase') state.mask[idx] = Math.min(state.mask[idx], Math.round(255*(1-feather)));
      else state.mask[idx] = Math.max(state.mask[idx], Math.round(255*feather));
    }
  }

  function applyRect(a, b) {
    snapshot();
    const x1 = Math.max(0, Math.floor(Math.min(a.x,b.x)));
    const x2 = Math.min(state.image.width, Math.ceil(Math.max(a.x,b.x)));
    const y1 = Math.max(0, Math.floor(Math.min(a.y,b.y)));
    const y2 = Math.min(state.image.height, Math.ceil(Math.max(a.y,b.y)));
    state.mask.fill(0);
    for (let y=y1; y<y2; y++) state.mask.fill(255, y*state.image.width+x1, y*state.image.width+x2);
    render();
  }

  function pointInPolygon(x,y,poly) {
    let inside = false;
    for (let i=0,j=poly.length-1;i<poly.length;j=i++) {
      const xi=poly[i].x, yi=poly[i].y, xj=poly[j].x, yj=poly[j].y;
      const intersect = ((yi>y)!=(yj>y)) && (x < (xj-xi)*(y-yi)/(yj-yi+1e-12)+xi);
      if (intersect) inside=!inside;
    }
    return inside;
  }
  function applyPolygon() {
    if (state.polygon.length < 3) return;
    snapshot();
    state.mask.fill(0);
    const xs = state.polygon.map(p=>p.x), ys=state.polygon.map(p=>p.y);
    const minX=Math.max(0,Math.floor(Math.min(...xs))), maxX=Math.min(state.image.width-1,Math.ceil(Math.max(...xs)));
    const minY=Math.max(0,Math.floor(Math.min(...ys))), maxY=Math.min(state.image.height-1,Math.ceil(Math.max(...ys)));
    for (let y=minY;y<=maxY;y++) for (let x=minX;x<=maxX;x++) if (pointInPolygon(x+.5,y+.5,state.polygon)) state.mask[y*state.image.width+x]=255;
    state.polygon=[];
    render();
  }

  function hexToRgb(hex) {
    const v = parseInt(hex.slice(1),16);
    return [(v>>16)&255,(v>>8)&255,v&255];
  }
  function colorDistance(r,g,b,kr,kg,kb) {
    return Math.sqrt((r-kr)**2 + (g-kg)**2 + (b-kb)**2);
  }

  function buildChromaMask() {
    if (!state.original) return null;
    const [kr,kg,kb] = hexToRgb($('keyColor').value);
    const tol = +$('tolerance').value;
    const softness = +$('softness').value;
    const connected = $('connectedOnly').checked;
    const w=state.original.width,h=state.original.height,data=state.original.data;
    const remove = new Uint8Array(w*h);

    const qualify = (p) => {
      const i=p*4;
      return colorDistance(data[i],data[i+1],data[i+2],kr,kg,kb) <= tol + softness;
    };

    if (connected) {
      const q = new Int32Array(w*h);
      let head=0,tail=0;
      const push = (p) => { if (!remove[p] && qualify(p)) { remove[p]=1; q[tail++]=p; } };
      for (let x=0;x<w;x++){ push(x); push((h-1)*w+x); }
      for (let y=0;y<h;y++){ push(y*w); push(y*w+w-1); }
      while (head<tail) {
        const p=q[head++], x=p%w, y=(p/w)|0;
        if (x>0) push(p-1); if (x<w-1) push(p+1); if (y>0) push(p-w); if (y<h-1) push(p+w);
      }
    } else {
      for (let p=0;p<w*h;p++) if (qualify(p)) remove[p]=1;
    }

    const out = state.mask.slice();
    for (let p=0;p<w*h;p++) {
      if (!remove[p]) continue;
      const i=p*4;
      const d=colorDistance(data[i],data[i+1],data[i+2],kr,kg,kb);
      let alpha;
      if (d <= tol) alpha=0;
      else if (softness <= 0) alpha=255;
      else alpha=Math.round(255*Math.min(1,(d-tol)/softness));
      out[p]=Math.min(out[p],alpha);
    }
    return out;
  }

  function applySpillToExport(data, mask) {
    const [kr,kg,kb]=hexToRgb($('keyColor').value);
    const strength=+$('spill').value/100;
    if (strength<=0) return;
    const keyMax=Math.max(kr,kg,kb), keyChannel = keyMax===kr?0:keyMax===kg?1:2;
    for (let p=0,i=0;p<mask.length;p++,i+=4) {
      if (mask[p]===0 || mask[p]===255) continue;
      const r=data[i],g=data[i+1],b=data[i+2];
      const others = keyChannel===0?(g+b)/2:keyChannel===1?(r+b)/2:(r+g)/2;
      const current = data[i+keyChannel];
      if (current>others) data[i+keyChannel]=Math.round(current-(current-others)*strength);
    }
  }

  function exportPNG() {
    if (!state.image) return;
    const off=document.createElement('canvas'); off.width=state.image.width; off.height=state.image.height;
    const c=off.getContext('2d');
    const out=new ImageData(new Uint8ClampedArray(state.original.data),state.image.width,state.image.height);
    applySpillToExport(out.data,state.mask);
    for(let p=0,i=0;p<state.mask.length;p++,i+=4) out.data[i+3]=Math.round(out.data[i+3]*state.mask[p]/255);
    c.putImageData(out,0,0);
    off.toBlob(blob=>{
      const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='cutlab-export.png'; a.click();
      setTimeout(()=>URL.revokeObjectURL(a.href),1000);
    },'image/png');
  }

  stage.addEventListener('pointerdown', e => {
    if (!state.image) return;
    const p=stageToImage(e.clientX,e.clientY);
    const wantsPan = state.tool==='pan' || state.spaceDown || e.button===1;
    if (wantsPan) {
      state.panning=true; state.lastPoint={x:e.clientX,y:e.clientY}; stage.setPointerCapture(e.pointerId); return;
    }
    if (state.pickMode && insideImage(p)) {
      const x=Math.floor(p.x),y=Math.floor(p.y),i=(y*state.image.width+x)*4,d=state.original.data;
      $('keyColor').value='#'+[d[i],d[i+1],d[i+2]].map(v=>v.toString(16).padStart(2,'0')).join('');
      state.pickMode=false; $('pickColorBtn').textContent='スポイト'; setStatus('キーカラーを取得しました'); return;
    }
    if (!insideImage(p)) return;
    if (['eraser','restore','brush'].includes(state.tool)) {
      snapshot(); state.drawing=true; state.lastPoint=p; stage.setPointerCapture(e.pointerId);
      paintLine(p,p,state.tool==='eraser'?'erase':'restore'); render();
    } else if (state.tool==='rect') {
      state.drawing=true; state.startPoint=p; state.lastPoint=p; stage.setPointerCapture(e.pointerId);
    } else if (state.tool==='polygon') {
      state.polygon.push(p); drawOverlay();
    }
  });

  stage.addEventListener('pointermove', e => {
    if (!state.image) return;
    if (state.panning) {
      state.offsetX += e.clientX-state.lastPoint.x; state.offsetY += e.clientY-state.lastPoint.y;
      state.lastPoint={x:e.clientX,y:e.clientY}; applyTransform(); return;
    }
    const p=stageToImage(e.clientX,e.clientY);
    if (state.drawing && ['eraser','restore','brush'].includes(state.tool)) {
      paintLine(state.lastPoint,p,state.tool==='eraser'?'erase':'restore'); state.lastPoint=p; render();
    } else if (state.drawing && state.tool==='rect') {
      drawOverlay();
      octx.save(); octx.strokeStyle='#74a7ff'; octx.fillStyle='rgba(80,130,255,.15)'; octx.lineWidth=Math.max(1,1.5/state.zoom);
      const a=state.startPoint; octx.fillRect(a.x,a.y,p.x-a.x,p.y-a.y); octx.strokeRect(a.x,a.y,p.x-a.x,p.y-a.y); octx.restore();
      state.lastPoint=p;
    } else if (state.tool==='polygon' && state.polygon.length) drawOverlay(p);
  });

  stage.addEventListener('pointerup', e => {
    if (state.panning) { state.panning=false; return; }
    if (!state.drawing) return;
    if (state.tool==='rect' && state.startPoint && state.lastPoint) applyRect(state.startPoint,state.lastPoint);
    state.drawing=false; state.startPoint=null; state.lastPoint=null;
  });
  stage.addEventListener('dblclick', e => {
    if (state.tool==='polygon' && state.polygon.length>=3) { e.preventDefault(); applyPolygon(); }
  });
  stage.addEventListener('wheel', e => {
    if (!state.image) return;
    e.preventDefault();
    const r=stage.getBoundingClientRect();
    const mx=e.clientX-r.left,my=e.clientY-r.top;
    const ix=(mx-state.offsetX)/state.zoom,iy=(my-state.offsetY)/state.zoom;
    const factor=e.deltaY<0?1.1:0.9;
    state.zoom=Math.max(.1,Math.min(4,state.zoom*factor));
    state.offsetX=mx-ix*state.zoom; state.offsetY=my-iy*state.zoom;
    $('zoomSlider').value=Math.round(state.zoom*100); $('zoomValue').textContent=Math.round(state.zoom*100);
    applyTransform();
  }, { passive:false });

  $('toolGrid').addEventListener('click', e => {
    const b=e.target.closest('[data-tool]'); if(!b)return;
    document.querySelectorAll('.tool').forEach(x=>x.classList.remove('active')); b.classList.add('active');
    state.tool=b.dataset.tool; state.polygon=[]; state.previewMask=null; drawOverlay(); render();
    setStatus(`ツール: ${b.textContent}`);
  });

  $('fileInput').addEventListener('change', e => loadImage(e.target.files[0]));
  ['dragenter','dragover'].forEach(t=>stage.addEventListener(t,e=>{e.preventDefault();stage.style.outline='2px solid #6d86ff';}));
  ['dragleave','drop'].forEach(t=>stage.addEventListener(t,e=>{e.preventDefault();stage.style.outline='';}));
  stage.addEventListener('drop', e=>loadImage(e.dataTransfer.files[0]));

  $('brushSize').addEventListener('input', e=>$('brushSizeValue').textContent=e.target.value);
  $('brushHardness').addEventListener('input', e=>$('brushHardnessValue').textContent=e.target.value);
  $('tolerance').addEventListener('input', e=>$('toleranceValue').textContent=e.target.value);
  $('softness').addEventListener('input', e=>$('softnessValue').textContent=e.target.value);
  $('spill').addEventListener('input', e=>$('spillValue').textContent=e.target.value);
  document.querySelectorAll('[data-color]').forEach(b=>b.addEventListener('click',()=>{$('keyColor').value=b.dataset.color;}));
  $('pickColorBtn').addEventListener('click',()=>{state.pickMode=!state.pickMode;$('pickColorBtn').textContent=state.pickMode?'画像をクリック':'スポイト';setStatus(state.pickMode?'背景色をクリックしてください':'スポイト解除');});
  $('previewChromaBtn').addEventListener('click',()=>{state.previewMask=buildChromaMask();render();setStatus('クロマキープレビュー');});
  $('applyChromaBtn').addEventListener('click',()=>{snapshot();state.mask=buildChromaMask()||state.mask;state.previewMask=null;render();setStatus('クロマキーを適用しました');});
  $('undoBtn').addEventListener('click',undo); $('redoBtn').addEventListener('click',redo);
  $('resetBtn').addEventListener('click',()=>{if(!state.image)return;snapshot();state.mask.fill(255);state.previewMask=null;render();});
  $('exportBtn').addEventListener('click',exportPNG);
  $('checkerToggle').addEventListener('change',e=>stage.classList.toggle('checker',e.target.checked));
  $('maskToggle').addEventListener('change',render);
  $('zoomSlider').addEventListener('input', e=>{
    if(!state.image)return; const rect=stage.getBoundingClientRect(); const old=state.zoom; const next=+e.target.value/100;
    const cx=rect.width/2,cy=rect.height/2,ix=(cx-state.offsetX)/old,iy=(cy-state.offsetY)/old;
    state.zoom=next; state.offsetX=cx-ix*next; state.offsetY=cy-iy*next; $('zoomValue').textContent=e.target.value; applyTransform();
  });

  window.addEventListener('keydown', e=>{
    if(e.code==='Space'){state.spaceDown=true;e.preventDefault();}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();}
  });
  window.addEventListener('keyup', e=>{if(e.code==='Space')state.spaceDown=false;});
  window.addEventListener('resize',()=>{if(state.image)fitImage();});
})();
