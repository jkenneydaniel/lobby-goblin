import {brokerClient} from './broker-client.js';
import http from 'node:http';
import {redact} from '../common.js';
import {DockerTransportError} from './docker-transport-error.js';

export function docker(method, route, data, {raw=false,timeout=150000,socketPath=process.env.DOCKER_SOCKET||'/var/run/docker.sock'}={}) {
  if(process.env.DOCKER_BROKER_SOCKET!==undefined||process.env.DOCKER_BROKER_TOKEN_FILE!==undefined)return brokerClient({socketPath:process.env.DOCKER_BROKER_SOCKET,tokenFile:process.env.DOCKER_BROKER_TOKEN_FILE}).docker(method,route,data,{raw,timeout});
  return new Promise((resolve,reject)=>{
    const body=data===undefined ? undefined : Buffer.from(JSON.stringify(data));
    const req=http.request({socketPath, path:route, method,
      headers:body?{'content-type':'application/json','content-length':body.length}:{}},res=>{
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>32*1024*1024){req.destroy(new Error('Docker response is too large.'));return;}chunks.push(chunk);});
      res.on('end',()=>{
        const value=Buffer.concat(chunks);
        if(res.statusCode>=400){let message;try{message=JSON.parse(value).message;}catch{message='Docker operation failed.';}reject(new DockerTransportError(res.statusCode===404?404:502,redact(typeof message==='string'?message:'Docker operation failed.')));return;}
        if(raw){resolve(value);return;}
        try{resolve(value.length?JSON.parse(value):null);}catch{reject(new Error('Invalid Docker response.'));}
      });
      res.on('error',reject);
    });
    req.setTimeout(timeout,()=>req.destroy(new Error('Docker operation timed out.')));req.on('error',reject);req.end(body);
  });
}
export function demultiplex(buffer) {
  const chunks=[];let offset=0;
  while(offset+8<=buffer.length){const length=buffer.readUInt32BE(offset+4);if(buffer[offset]>2||offset+8+length>buffer.length)return buffer.toString('utf8');chunks.push(buffer.subarray(offset+8,offset+8+length));offset+=8+length;}
  return Buffer.concat(chunks).toString('utf8');
}
