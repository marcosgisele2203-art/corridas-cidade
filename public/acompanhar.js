(()=>{
'use strict';
const $=id=>document.getElementById(id);
const mapCard=$('mapCard');
const token=new URLSearchParams(location.hash.slice(1)).get('token')||'';
history.replaceState(null,'',location.pathname);
const estados={aceita:'Motorista a caminho',chegou:'Motorista chegou',em_andamento:'Viagem em andamento'};
const tipoEmoji={carro:'🚗',moto:'🏍️',van:'🚐',caminhao:'🚚'};
let map,marker,intervalo;
if(!/^[A-Za-z0-9_-]{43}$/.test(token)){
 $('status').textContent='Link inválido. Solicite um novo link à central.';mapCard.classList.add('oculto');return;
}
async function consultar(){
 try{
  const resposta=await fetch('/api/publico/acompanhamento',{
   method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token}),cache:'no-store'
  });
  if(!resposta.ok){
   $('status').textContent=resposta.status===410?'A viagem terminou ou o link expirou.':'O acompanhamento não está disponível.';
   mapCard.classList.add('oculto');clearInterval(intervalo);return;
  }
  const d=await resposta.json();
  $('status').textContent=estados[d.status]||'Acompanhamento ativo';
  $('veiculo').textContent=(tipoEmoji[d.tipo]||'🚘')+' '+(d.veiculo||'Veículo')+(d.placa?' · '+d.placa:'');
  $('trajeto').textContent='📍 Origem: '+(d.origem||'Não informada')+' | 🏁 Destino: '+(d.destino||'Não informado');
  if(!d.gps_recente||!d.posicao){
   $('gps').textContent='Sem posição recente do motorista. O mapa será atualizado quando houver novo GPS.';
   return;
  }
  const ponto=[Number(d.posicao.lat),Number(d.posicao.lng)];
  if(!Number.isFinite(ponto[0])||!Number.isFinite(ponto[1]))return;
  if(!map){
   if(!window.L){$('gps').textContent='Mapa temporariamente indisponível.';return;}
   map=L.map('mapa').setView(ponto,15);
   mapaFundo(map);
   marker=L.marker(ponto).addTo(map).bindPopup('Posição recente do motorista');
  }else{
   marker.setLatLng(ponto);map.panTo(ponto,{animate:true});
  }
  $('gps').textContent='Última atualização do GPS: '+new Date(d.posicao.atualizado_em).toLocaleTimeString('pt-BR')+'. A posição pode ser aproximada.';
 }catch{
  $('status').textContent='Falha temporária na conexão. Tentando novamente.';
 }
}
consultar();
intervalo=setInterval(()=>{if(!document.hidden)consultar();},15000);
window.addEventListener('pagehide',()=>clearInterval(intervalo));
})();