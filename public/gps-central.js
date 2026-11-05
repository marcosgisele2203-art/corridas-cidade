(()=>{
'use strict';
const $=id=>document.getElementById(id), markers=new Map();let map,timer;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
$('token').value=localStorage.getItem('vai-manu-mapbox-public-token')||'';
async function atualizar(){
 try{
  const r=await fetch('/api/central/gps',{credentials:'same-origin',cache:'no-store'});
  if(r.status===401){$('status').textContent='Entre no painel da central para visualizar os motoristas.';clearInterval(timer);return;}
  if(!r.ok) throw Error('Consulta indisponível ('+r.status+').');
  const d=await r.json();const lista=d.motoristas||[];const ids=new Set();
  for(const m of lista){
   const id=String(m.id);ids.add(id);
   let marker=markers.get(id);
   if(!marker){marker=new mapboxgl.Marker({color:'#087b59'}).setLngLat([m.lng,m.lat]).addTo(map);markers.set(id,marker);}
   else marker.setLngLat([m.lng,m.lat]);
   marker.setPopup(new mapboxgl.Popup({offset:20}).setHTML('<b>'+esc(m.nome)+'</b><p>'+esc(m.tipo)+' · '+esc(m.carro)+'</p><small>Atualizado: '+esc(new Date(m.local_em).toLocaleTimeString('pt-BR'))+'</small>'));
  }
  for(const [id,m] of markers)if(!ids.has(id)){m.remove();markers.delete(id);}
  $('motoristas').innerHTML=lista.length?lista.map(m=>'<div>🟢 '+esc(m.nome)+' — '+esc(m.tipo)+' · '+esc(m.carro)+(m.corrida_atual?' · Corrida #'+esc(m.corrida_atual):'')+'</div>').join(''):'Nenhum motorista está compartilhando GPS neste momento.';
  $('status').textContent='Central conectada · '+lista.length+' motorista(s) visível(is) · '+new Date().toLocaleTimeString('pt-BR');
 }catch(e){$('status').textContent=e.message;}
}
$('abrir').onclick=()=>{
 const token=$('token').value.trim();
 if(!/^pk\.[A-Za-z0-9._-]{10,}$/.test(token)){$('status').textContent='Informe token Mapbox público válido (pk.).';return;}
 if(!window.mapboxgl){$('status').textContent='Biblioteca Mapbox indisponível.';return;}
 localStorage.setItem('vai-manu-mapbox-public-token',token);
 mapboxgl.accessToken=token;
 if(timer)clearInterval(timer);
 for(const m of markers.values())m.remove();markers.clear();
 if(map)map.remove();
 map=new mapboxgl.Map({container:'mapa',style:'mapbox://styles/mapbox/streets-v12',center:[-56.378,-20.240],zoom:13});
 map.addControl(new mapboxgl.NavigationControl());
 map.once('load',()=>{atualizar();timer=setInterval(()=>{if(!document.hidden)atualizar();},15000)});
 map.on('error',e=>{$('status').textContent=e.error?.message||'Erro ao carregar mapa.'});
};
window.addEventListener('pagehide',()=>clearInterval(timer));
})();