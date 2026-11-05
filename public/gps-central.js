(()=>{
'use strict';
const $=id=>document.getElementById(id), markers=new Map();
let map,timer,requestInFlight=false;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const veiculo=tipo=>({carro:'🚗',moto:'🏍️',van:'🚐',caminhao:'🚚',frete:'🚚'}[String(tipo).toLowerCase()]||'🚘');
const statusDo=m=>m.corrida_atual?'Em corrida':(Date.now()-new Date(m.local_em).getTime()>45000?'GPS atrasado':'Disponível');
const classeDo=m=>m.corrida_atual?'ocupado':(Date.now()-new Date(m.local_em).getTime()>45000?'atrasado':'disponivel');
$('token').value=localStorage.getItem('vai-manu-mapbox-public-token')||'';
function elementoMarcador(m){
 const el=document.createElement('div');el.className='marcador '+classeDo(m);
 el.textContent=veiculo(m.tipo);el.setAttribute('aria-label','Motorista '+statusDo(m));
 return el;
}
function popup(m){
 const horario=new Date(m.local_em).toLocaleTimeString('pt-BR');
 return '<strong>'+esc(m.nome)+'</strong><p>'+esc(m.tipo)+' · '+esc(m.carro)+'</p>'+
   '<p>'+esc(statusDo(m))+'</p><small>Último GPS: '+esc(horario)+'</small>';
}
async function atualizar(){
 if(requestInFlight||!map||!map.loaded())return;
 requestInFlight=true;
 try{
  const r=await fetch('/api/central/gps',{credentials:'same-origin',cache:'no-store'});
  if(r.status===401){$('status').textContent='Sessão encerrada. Entre novamente no painel da central.';clearInterval(timer);return;}
  if(!r.ok)throw Error('Consulta indisponível ('+r.status+').');
  const d=await r.json(),lista=Array.isArray(d.motoristas)?d.motoristas:[];
  const ids=new Set();
  for(const m of lista){
   if(!Number.isFinite(Number(m.lng))||!Number.isFinite(Number(m.lat)))continue;
   const id=String(m.id);ids.add(id);
   const coords=[Number(m.lng),Number(m.lat)];
   let item=markers.get(id);
   if(!item){
    const marker=new mapboxgl.Marker({element:elementoMarcador(m)}).setLngLat(coords).addTo(map);
    marker.setPopup(new mapboxgl.Popup({offset:20}).setHTML(popup(m)));
    item={marker};markers.set(id,item);
   }else{
    item.marker.setLngLat(coords);
    const el=item.marker.getElement();
    el.className='marcador '+classeDo(m);el.textContent=veiculo(m.tipo);
    el.setAttribute('aria-label','Motorista '+statusDo(m));
    item.marker.getPopup().setHTML(popup(m));
   }
  }
  for(const [id,item] of markers)if(!ids.has(id)){item.marker.remove();markers.delete(id);}
  $('motoristas').replaceChildren();
  if(!lista.length){
   const vazio=document.createElement('p');vazio.textContent='Nenhum motorista com GPS recente. Os registros com mais de 2 minutos não aparecem.';$('motoristas').append(vazio);
  }
  for(const m of lista){
   const item=document.createElement('button');
   item.className='motorista-card';
   const tipo=veiculo(m.tipo),situacao=statusDo(m);
   const emoji=m.corrida_atual?'🟠':situacao==='GPS atrasado'?'🟡':'🟢';
   item.textContent=tipo+' '+m.nome+' · '+m.carro+' — '+emoji+' '+situacao;
   item.onclick=()=>{
    const ponto=markers.get(String(m.id));
    if(!ponto)return;
    map.flyTo({center:ponto.marker.getLngLat(),zoom:16});
    ponto.marker.togglePopup();
   };
   $('motoristas').append(item);
  }
  $('status').textContent='Central conectada · '+lista.length+' motorista(s) com GPS recente · Atualizado às '+new Date().toLocaleTimeString('pt-BR');
 }catch(e){$('status').textContent=e.message;}
 finally{requestInFlight=false;}
}
$('abrir').onclick=()=>{
 const token=$('token').value.trim();
 if(!/^pk\.[A-Za-z0-9._-]{10,}$/.test(token)){$('status').textContent='Informe um token público válido (pk.).';return;}
 if(!window.mapboxgl){$('status').textContent='Biblioteca de mapas indisponível.';return;}
 localStorage.setItem('vai-manu-mapbox-public-token',token);
 mapboxgl.accessToken=token;
 if(timer)clearInterval(timer);
 for(const item of markers.values())item.marker.remove();
 markers.clear();if(map)map.remove();
 map=new mapboxgl.Map({container:'mapa',style:'mapbox://styles/mapbox/streets-v12',center:[-56.378,-20.240],zoom:13});
 map.addControl(new mapboxgl.NavigationControl());
 map.once('load',()=>{atualizar();timer=setInterval(()=>{if(!document.hidden)atualizar();},15000);});
 map.on('error',e=>{$('status').textContent=e.error?.message||'Erro ao carregar mapa.';});
};
window.addEventListener('pagehide',()=>clearInterval(timer));
})();