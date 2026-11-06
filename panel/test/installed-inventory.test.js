import test from 'node:test';
import assert from 'node:assert/strict';
import {installedInventoryReport} from '../public/mod-library.js';

test('installed report keeps complete received order and only public observations without mutating frozen inputs', () => {
  const items = Object.freeze([
    Object.freeze({id:'same',title:'<script>世界 & "literal"</script>',version:'1.2',enabled:false,managed:true,modified:true,sha256:'Ab'.repeat(32),name:'PRIVATE.cs',url:'https://private.invalid',dependencies:['PRIVATE'],config:'PRIVATE'}),
    Object.freeze({id:'manual',title:'Manual',version:null,enabled:true,managed:false,modified:false,sha256:'bad',source:{token:'PRIVATE'},review:'PRIVATE'}),
    Object.freeze({id:'same',title:'Unknown',enabled:false,managed:false,modified:true,sha256:'a'.repeat(63)}),
  ]);
  const input = Object.freeze({game:'rust',scope:'oxide',version:'2.0.1',items,account:{token:'PRIVATE'},policy:'PRIVATE',note:'PRIVATE',hostId:'PRIVATE'});
  const before = JSON.stringify(input), report = installedInventoryReport(input);
  assert.deepEqual(report, {game:'rust',scope:'oxide',reportedScopeVersion:'2.0.1',items:[
    {id:'same',title:'<script>世界 & "literal"</script>',version:'1.2',enabled:false,managed:true,modified:true,sha256:'Ab'.repeat(32)},
    {id:'manual',title:'Manual',version:null,enabled:true,managed:false,modified:false,sha256:null},
    {id:'same',title:'Unknown',version:null,enabled:false,managed:false,modified:true,sha256:null},
  ]});
  assert.equal(JSON.stringify(input), before);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
  assert.notEqual(report.items, items);
});

test('empty current framework inventory and unknown scope version stay honest', () => {
  assert.deepEqual(installedInventoryReport(Object.freeze({game:'rust',scope:'none',items:Object.freeze([])})), {game:'rust',scope:'none',reportedScopeVersion:null,items:[]});
});

test('only received complete hexadecimal digests are emitted, without guessing versions', () => {
  const hashes = [null,undefined,'g'.repeat(64),' '+ 'a'.repeat(64),'a'.repeat(65),42,'F'.repeat(64)];
  const report = installedInventoryReport({game:'factorio',scope:'factorio',version:null,items:hashes.map((sha256,index)=>({id:String(index),title:'Observed',sha256,version:null,enabled:false,managed:false,modified:false}))});
  assert.deepEqual(report.items.map(item=>item.sha256),[null,null,null,null,null,null,'F'.repeat(64)]);
  assert.ok(report.items.every(item=>item.version===null));
  assert.equal(report.items.length, hashes.length);
});
