const video=document.getElementById('preview');
const statusText=document.getElementById('statusText');
const effectName=document.getElementById('effectName');
const intensity=document.getElementById('intensity');
const intensityValue=document.getElementById('intensityValue');
const recordBtn=document.getElementById('record');
const downloadBtn=document.getElementById('download');
const muteBtn=document.getElementById('mute');
const effectsBox=document.querySelector('.effects');
const zoomBox=document.createElement('div');
zoomBox.className='zoom-control';
zoomBox.innerHTML='<span>−</span><input id="zoom" type="range" min="1" max="4" step="0.1" value="1" aria-label="Zoom"><span>+</span><output id="zoomValue">1.0×</output>';
effectsBox.parentNode.insertBefore(zoomBox,effectsBox);

const switchBtn=document.getElementById('switchCam');

let facing='user', stream, audioCtx, source, destination, recorder, chunks=[];
let current='normal', muted=false, recordedUrl=null;

const filters={
  normal:{gain:1, low:20, high:20000, distortion:0},
  robot:{gain:1, low:180, high:4200, distortion:55},
  demon:{gain:1.15, low:35, high:3800, distortion:18},
  radio:{gain:1.05, low:350, high:3200, distortion:28},
  glitch:{gain:1, low:120, high:8500, distortion:80}
};

function curve(amount){
  const n=44100, c=new Float32Array(n), k=amount;
  for(let i=0;i<n;i++){const x=i*2/n-1;c[i]=((3+k)*x*20*Math.PI/180)/(Math.PI+k*Math.abs(x));}
  return c;
}

let zoom=1, zoomMin=1, zoomMax=4, hardwareZoom=false;

function updateZoomUI(){
  const z=document.getElementById('zoom');
  const zv=document.getElementById('zoomValue');
  if(z){ z.value=zoom; }
  if(zv){ zv.textContent=zoom.toFixed(1)+'×'; }
  const note=document.querySelector('.camera-note');
  if(note) note.textContent=(hardwareZoom?'ZOOM CÁMARA':'ZOOM DIGITAL')+' · '+zoom.toFixed(1)+'×';
}

async function applyZoom(){
  const track=stream?.getVideoTracks?.()[0];
  if(!track) return;
  const caps=track.getCapabilities ? track.getCapabilities() : {};
  hardwareZoom=!!caps.zoom;
  if(hardwareZoom){
    zoomMin=caps.zoom.min ?? 1;
    zoomMax=Math.min(caps.zoom.max ?? 4,4);
    zoom=Math.max(zoomMin,Math.min(zoomMax,Number(zoom)));
    try{ await track.applyConstraints({advanced:[{zoom}]}); }catch(e){ hardwareZoom=false; }
  }
  // Fallback: digital zoom if the browser does not expose camera zoom.
  if(!hardwareZoom) video.style.transform=`scale(${Math.max(1,zoom)})`;
  else video.style.transform='scale(1)';
  const z=document.getElementById('zoom');
  if(z){z.min=zoomMin;z.max=zoomMax;}
  updateZoomUI();
}

async function startCamera(){
  if(stream) stream.getTracks().forEach(t=>t.stop());
  stream=await navigator.mediaDevices.getUserMedia({
    video:{facingMode:facing,width:{ideal:1080},height:{ideal:1920}},
    audio:true
  });
  video.srcObject=stream;
  video.style.transform='scale(1)';
  zoom=1;
  setupAudio(stream);
  await applyZoom();
  statusText.textContent='CÁMARA LISTA';
}

function setupAudio(s){
  if(audioCtx) audioCtx.close();
  audioCtx=new (window.AudioContext||window.webkitAudioContext)();
  source=audioCtx.createMediaStreamSource(s);
  destination=audioCtx.createMediaStreamDestination();

  const inputGain=audioCtx.createGain();
  const low=audioCtx.createBiquadFilter();
  const high=audioCtx.createBiquadFilter();
  const distortion=audioCtx.createWaveShaper();
  const compressor=audioCtx.createDynamicsCompressor();

  // Mic -> effects -> MediaStreamDestination (this is the audio that gets recorded)
  source.connect(inputGain);
  inputGain.connect(low);
  low.connect(high);
  high.connect(distortion);
  distortion.connect(compressor);
  compressor.connect(destination);

  // Never route the microphone to the speakers: prevents feedback/echo.
  window.audioNodes={inputGain,low,high,distortion,compressor};
  applyEffect();
}

function applyEffect(){
  if(!window.audioNodes)return;
  const f=filters[current], p=Number(intensity.value)/100;
  const n=window.audioNodes;
  n.inputGain.gain.value=muted?0:0.55+(p*.45);
  n.low.frequency.value=f.low+(20-f.low)*(1-p);
  n.high.frequency.value=f.high+(20000-f.high)*(1-p);
  n.distortion.curve=curve(f.distortion*p);
  n.distortion.oversample='4x';
  effectName.textContent=current.toUpperCase();
}

document.querySelectorAll('.effect').forEach(btn=>{
  btn.onclick=()=>{
    document.querySelectorAll('.effect').forEach(x=>x.classList.remove('active'));
    btn.classList.add('active');
    current=btn.dataset.effect;
    applyEffect();
  };
});

intensity.oninput=()=>{intensityValue.textContent=intensity.value+'%';applyEffect()};
document.getElementById('zoom').oninput=async(e)=>{
  zoom=Number(e.target.value);
  await applyZoom();
};

recordBtn.onclick=()=>{
  if(recorder?.state==='recording'){recorder.stop();return}
  if(!stream)return;
  if(audioCtx && audioCtx.state==='suspended') audioCtx.resume();
  chunks=[];
  const combined=new MediaStream([
    stream.getVideoTracks()[0],
    destination.stream.getAudioTracks()[0]
  ]);
  const type=MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')?'video/webm;codecs=vp9,opus':'video/webm';
  recorder=new MediaRecorder(combined,{mimeType:type});
  recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
  recorder.onstop=()=>{
    const blob=new Blob(chunks,{type:'video/webm'});
    recordedUrl=URL.createObjectURL(blob);
    downloadBtn.disabled=false;
    downloadBtn.onclick=()=>{
      const a=document.createElement('a');a.href=recordedUrl;a.download='neo-cam-'+Date.now()+'.webm';a.click();
    };
    statusText.textContent='VIDEO LISTO';
  };
  recorder.start();
  recordBtn.classList.add('recording');
  statusText.textContent='GRABANDO';
};

muteBtn.onclick=()=>{
  muted=!muted;
  muteBtn.textContent=muted?'🔇':'🎙️';
  applyEffect();
};

switchBtn.onclick=async()=>{
  facing=facing==='user'?'environment':'user';
  try{await startCamera()}catch(e){statusText.textContent='NO SE PUDO CAMBIAR'} 
};

(async()=>{
  try{await startCamera()}catch(e){
    statusText.textContent='PERMISO DE CÁMARA REQUERIDO';
    console.error(e);
  }
})();
