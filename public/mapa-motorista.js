/* Vai de Manu: mapa independente, sem alterar WhatsApp ou banco. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const CENTRO = [-56.378,-20.240]; // Miranda-MS (posição inicial aproximada)
let map, gpsMarker, markerA, markerB, origem, destino, watchId=null, simulation=false, runId=0;
let shared=false, lastSent=0, sending=false;
const status = msg => { $('status').textContent=msg; };
const blank = () => ({type:'FeatureCollection',features:[]});
const controls = state => ['gps','simular','limpar'].forEach(id => $(id).disabled=!state);
$('token').value = localStorage.getItem('vai-manu-mapbox-public-token') || '';
async function stopShare(){
 shared=false; $('compartilhar').disabled=false; $('pararCompartilhar').disabled=true;
 $('compartilhamentoStatus').textContent='Compartilhamento desligado.';
 try { await fetch('/api/motorista/localizacao',{method:'DELETE',credentials:'same-origin'}); }catch{}
}
async function sendLocation(lng,lat){
 if(!shared || simulation || sending || Date.now()-lastSent<12000) return;
 sending=true;
 try{
  const r=await fetch('/api/motorista/localizacao',{method:'POST',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({lat,lng})});
  if(!r.ok){
    const d=await r.json().catch(()=>({}));
    shared=false;$('compartilhar').disabled=false;$('pararCompartilhar').disabled=true;
    $('compartilhamentoStatus').textContent='Compartilhamento interrompido: '+(d.erro||'Erro HTTP '+r.status);
  }else{
    lastSent=Date.now();
    $('compartilhamentoStatus').textContent='📡 Compartilhando GPS real com a central. Último envio: '+new Date().toLocaleTimeString('pt-BR');
  }
 }catch(e){$('compartilhamentoStatus').textContent='Falha de rede: '+e.message;}
 finally{sending=false;}
}
function stop(){
 if(watchId!==null) navigator.geolocation.clearWatch(watchId);
 watchId=null; simulation=false; $('parar').disabled=true;
 if(shared) stopShare();
 status('Localização interrompida. Nada é enviado ao servidor.');
}
function gpsPosition(lng,lat,accuracy,kind){
 if(!gpsMarker) gpsMarker = new mapboxgl.Marker({color:'#267bde'}).setLngLat([lng,lat]).addTo(map);
 else gpsMarker.setLngLat([lng,lat]);
 map.easeTo({center:[lng,lat],zoom:15});
 status(kind+': posição exibida no mapa'+(Number.isFinite(accuracy)?' (precisão estimada '+Math.round(accuracy)+' m)':'')+'.');
 if(kind==='GPS') sendLocation(lng,lat);
}
function clearRoute(){
 ++runId;
 origem=destino=null;
 markerA?.remove();markerB?.remove();markerA=markerB=null;
 if(map?.getSource('rota')) map.getSource('rota').setData(blank());
 $('resumo').textContent='Nenhuma rota selecionada.';
}
async function route(){
 const id=++runId, token=$('token').value.trim(),profile=$('perfil').value;
 const coords=[origem,destino].map(p=>p.join(',')).join(';');
 $('resumo').textContent='Calculando trajeto pelas ruas…';
 try{
  const url='https://api.mapbox.com/directions/v5/mapbox/'+profile+'/'+coords+'?geometries=geojson&overview=full&access_token='+encodeURIComponent(token);
  const response=await fetch(url);
  const data=await response.json();
  if(id!==runId) return;
  if(!response.ok || !data.routes?.length) throw Error(data.message||'Rota indisponível');
  const r=data.routes[0];
  map.getSource('rota').setData({type:'Feature',properties:{},geometry:r.geometry});
  const bounds=new mapboxgl.LngLatBounds(origem,origem).extend(destino);
  map.fitBounds(bounds,{padding:65,maxZoom:16});
  $('resumo').textContent='Distância estimada: '+(r.distance/1000).toFixed(2).replace('.',',')+' km · Tempo estimado: '+Math.round(r.duration/60)+' min. Não é preço de corrida.';
 }catch(err){if(id===runId) $('resumo').textContent='Não foi possível calcular a rota: '+err.message;}
}
function clickMap(e){
 if(origem && destino) clearRoute();
 if(!origem){
   origem=[e.lngLat.lng,e.lngLat.lat];
   markerA=new mapboxgl.Marker({color:'#0a8d61'}).setLngLat(origem).addTo(map);
   $('resumo').textContent='Origem definida. Clique no destino.';
 }else{
   destino=[e.lngLat.lng,e.lngLat.lat];
   markerB=new mapboxgl.Marker({color:'#e3692b'}).setLngLat(destino).addTo(map);
   route();
 }
}
$('carregar').onclick=()=>{
 const token=$('token').value.trim();
 if(!/^pk\.[A-Za-z0-9._-]{10,}$/.test(token)){status('Informe um token público Mapbox válido, começando com pk.');return;}
 if(!window.mapboxgl){status('Biblioteca Mapbox não carregou. Verifique a internet.');return;}
 stop();
 if(map){map.remove();map=null;}
 gpsMarker=markerA=markerB=null; origem=destino=null;
 mapboxgl.accessToken=token;
 localStorage.setItem('vai-manu-mapbox-public-token',token);
 try{
  map=new mapboxgl.Map({container:'mapa',style:'mapbox://styles/mapbox/streets-v12',center:CENTRO,zoom:13});
  map.addControl(new mapboxgl.NavigationControl(),'top-right');
  map.on('load',()=>{
   map.addSource('rota',{type:'geojson',data:blank()});
   map.addLayer({id:'rota-linha',type:'line',source:'rota',layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'#087b59','line-width':6,'line-opacity':0.86}});
   map.on('click',clickMap); controls(true);
   $('compartilhar').disabled=false;
   $('resumo').textContent='Clique no mapa para escolher a origem.';
   status('Mapa carregado. Você pode ativar GPS ou usar o simulador.');
  });
  map.on('error',e=>status('Erro no mapa: '+(e.error?.message||'verifique seu token, permissões e conexão.')));
 }catch(e){status('Erro ao iniciar mapa: '+e.message);}
};
$('gps').onclick=()=>{
 if(!navigator.geolocation){status('Seu navegador não oferece geolocalização.');return;}
 if(!window.isSecureContext){status('GPS exige HTTPS (ou localhost). Abra o site pelo endereço seguro.');return;}
 stop();
 $('parar').disabled=false;
 status('Solicitando permissão para usar a localização do aparelho…');
 watchId=navigator.geolocation.watchPosition(
   p=>gpsPosition(p.coords.longitude,p.coords.latitude,p.coords.accuracy,'GPS'),
   e=>{status('GPS indisponível: '+e.message+'. Use o simulador para testar.');stop();},
   {enableHighAccuracy:true,maximumAge:5000,timeout:15000}
 );
};
$('simular').onclick=()=>{
 stop();simulation=true;$('parar').disabled=false;
 // Um ponto demonstrativo no centro de Miranda; nunca envia dados nem finge GPS real.
 gpsPosition(CENTRO[0],CENTRO[1],null,'Simulador');
 status('SIMULAÇÃO: marcador de teste no centro aproximado de Miranda-MS. Nenhum GPS real ativo.');
};
$('parar').onclick=stop;
$('limpar').onclick=clearRoute;
$('perfil').onchange=()=>{if(origem&&destino)route();};
$('compartilhar').onclick=async()=>{
 if(simulation){$('compartilhamentoStatus').textContent='Simulador não pode compartilhar localização.';return;}
 if(watchId===null){$('compartilhamentoStatus').textContent='Ative o GPS real antes de compartilhar.';return;}
 try{
   const r=await fetch('/api/motorista/eu',{credentials:'same-origin'});
   if(!r.ok) throw Error('Entre no painel do motorista no servidor da central (não no servidor estático).');
   const d=await r.json();
   if(!d.motorista?.aprovado||!d.motorista?.online) throw Error('Motorista precisa estar aprovado e online.');
   shared=true;lastSent=0;$('compartilhar').disabled=true;$('pararCompartilhar').disabled=false;
   $('compartilhamentoStatus').textContent='Compartilhamento ativado. Aguardando atualização real do GPS…';
 }catch(e){$('compartilhamentoStatus').textContent=e.message;}
};
$('pararCompartilhar').onclick=stopShare;
// Evita manter compartilhamento quando a aba é ocultada.
document.addEventListener('visibilitychange',()=>{if(document.hidden&&shared)stopShare();});
window.addEventListener('pagehide',()=>{if(shared){navigator.sendBeacon('/api/motorista/localizacao/parar','');}stop();});
})();