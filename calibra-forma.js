/* Calibração dos limiares de forma. É daqui que saem os números do README:
   rode `node calibra-forma.js` depois de mexer em qualquer limiar.
   São cenas sintéticas — não substituem calibração com fotos da casa. */
global.window = global;
require('./nucleo.js');
const L=320,A=240;
function cena({raio=88,forma='circulo',tilt=1,desvio=0}={}){
  const d=new Uint8ClampedArray(L*A*4); const cx=L/2, cy=A/2;
  const põe=(x,y,r,g,b)=>{if(x<0||y<0||x>=L||y>=A)return;const i=((y|0)*L+(x|0))*4;d[i]=r;d[i+1]=g;d[i+2]=b;d[i+3]=255;};
  for(let y=0;y<A;y++)for(let x=0;x<L;x++){
    const dx=x-cx, dy=(y-cy)/tilt;
    let dist;
    if(forma==='quadrado') dist=Math.max(Math.abs(dx),Math.abs(dy));
    else if(forma==='hexagono'){const a=Math.atan2(dy,dx);const r=Math.hypot(dx,dy);dist=r/ (1/Math.cos(((a%(Math.PI/3))+Math.PI/3)%(Math.PI/3)-Math.PI/6));}
    else dist=Math.hypot(dx,dy);
    if(dist>raio) põe(x,y,26,24,22); else põe(x,y,238,236,231);
  }
  for(let y=0;y<A;y++)for(let x=0;x<L;x++) if(Math.hypot(x-cx-desvio,(y-cy)/tilt)<raio*0.42) põe(x,y,150,82,46);
  return {width:L,height:A,data:d};
}
// instrumenta: reimplementa a extração da máscara para medir desencaixe direto
const N = global.Nucleo;
function analisa(img,rot){
  const r = N.medir(img);
  console.log(rot.padEnd(28), r.falha ? 'RECUSA: '+r.falha : `irreg=${r.irregularidade} desencaixe=${r.desencaixe} razao=${r.razaoElipse}`);
}
analisa(cena({forma:'circulo'}),'prato de frente');
analisa(cena({forma:'circulo',tilt:0.87}),'prato inclinado 30 graus');
analisa(cena({forma:'circulo',tilt:0.707}),'prato inclinado 45 graus');
analisa(cena({forma:'circulo',tilt:0.5}),'prato inclinado 60 graus');
analisa(cena({forma:'quadrado'}),'tabua quadrada');
analisa(cena({forma:'hexagono'}),'tabua hexagonal');
