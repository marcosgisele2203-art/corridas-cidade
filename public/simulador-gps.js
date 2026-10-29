// Simulador visual: nunca envia posicao para o servidor.
(() => {
 let timer=null, marker=null, indice=0, pontos=[];
 const caixa=document.createElement('div');
 caixa.id='simuladorGps';
 caixa.innerHTML='<hr><strong>🧪 GPS SIMULADO — somente teste</strong><p id="simStatus">Sem simulacao ativa.</p><div class="botoes"><button type="button" id="simIniciar">▶ Iniciar simulacao</button><button type="button" id="simPausar" class="sec">Pausar</button><button type="button" id="simParar" class="sec">Parar</button></div><small>O carro se move apenas no mapa deste navegador. Nenhuma posicao simulada e enviada ao servidor.</small>';
 function parar(){if(timer){clearInterval(timer);timer=null;}if(marker&&mapaCorrida){mapaCorrida.removeLayer(marker);}marker=null;indice=0;pontos=[];const el=document.getElementById('simStatus');if(el)el.textContent='Simulacao parada.';}
 function iniciar(){
   if(typeof mapaCorrida==='undefined'||!mapaCorrida){caixa.querySelector('#simStatus').textContent='Abra uma corrida com mapa para simular.';return;}
   if(timer)return;
   if(!pontos.length){
     mapaCorrida.eachLayer(layer=>{if(layer instanceof L.GeoJSON&&layer.toGeoJSON){const geo=layer.toGeoJSON();const feature=geo.features?.[0]||geo;const coords=feature.geometry?.coordinates;if(Array.isArray(coords)&&coords.length>1)pontos=coords.map(p=>[p[1],p[0]]);}});
     if(!pontos.length){caixa.querySelector('#simStatus').textContent='Rota ainda nao carregada no mapa.';return;}
     indice=0;marker=L.marker(pontos[0]).addTo(mapaCorrida).bindPopup('🧪 Veiculo simulado');
   }
   caixa.querySelector('#simStatus').textContent='SIMULACAO ATIVA — posicao ficticia';
   timer=setInterval(()=>{if(!mapaCorrida||!document.getElementById('mapaCorrida')){parar();return;}indice=(indice+1)%pontos.length;marker.setLatLng(pontos[indice]);},650);
 }
 caixa.querySelector('#simIniciar').onclick=iniciar;
 caixa.querySelector('#simPausar').onclick=()=>{if(timer){clearInterval(timer);timer=null;caixa.querySelector('#simStatus').textContent='Simulacao pausada.';}};
 caixa.querySelector('#simParar').onclick=parar;
 const attach=()=>{const gps=document.getElementById('painelGps');if(!gps)return;const configurado=typeof eu!=='undefined'&&eu?.central?.simulador_gps===true;if(configurado){if(!caixa.isConnected)gps.append(caixa);}else {if(caixa.isConnected){parar();caixa.remove();}let aviso=document.getElementById('simuladorDiagnostico');if(!aviso){aviso=document.createElement('p');aviso.id='simuladorDiagnostico';aviso.className='dica';gps.append(aviso);}aviso.textContent=typeof eu==='undefined'||!eu?'Simulador: aguardando login.':'Simulador: desativado na configuracao recebida do servidor.';return;}const aviso=document.getElementById('simuladorDiagnostico');if(aviso)aviso.remove();};
 setInterval(attach,1500);attach();
})();
