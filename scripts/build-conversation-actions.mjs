import {readFile,writeFile,realpath} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
const root=fileURLToPath(new URL('../',import.meta.url));
/** Refresh helpers only inside reviewed SDK/client boundaries; never transplant an old client bundle. */
export async function buildConversationActions({runtimeRoot=path.join(root,'runtime'),overlayRoot=path.join(root,'runtime/overlays')}={}) {
 let version;
 for(const name of ['dsh-session','dsh-client-ui-chat','dsh-client-ui-conversation']) {
  const pkg=JSON.parse(await readFile(path.join(runtimeRoot,'node_modules/@deepseek-ai',name,'package.json'),'utf8'));
  /* ⚠️ 本仓库运行时钉 0.2.1-rc.5，而会话编辑依赖的 conversation/edit 必选事件与
     @deepseek-ai/dsh-session/conversation-edit 导出在 rc.5 尚不存在（rc.5 里命中 0）
     ⇒ 该能力只对 alpha.1 / rc.2 评审过。版本不在评审范围内时**跳过生成并保留现有产物**，
     不让整条构建链因一个未适配的能力而中断（DSH-PHONE PATCH 2026-11-02）。
     内核升到带该事件的版本后，把版本加进下面的名单即可恢复。 */
  if(pkg.name!=='@deepseek-ai/'+name||!['0.2.1-alpha.1','0.2.1-rc.2'].includes(pkg.version)||version&&pkg.version!==version){
    console.log('跳过会话编辑生成：'+name+' 版本 '+pkg.version+' 不在已评审范围 (alpha.1 / rc.2)');
    return;
  }
  version=pkg.version;
 }
 const plans=[];
 for(const [input,output,name,exports,boot]of [
  [path.join(root,'peer/conversation-actions/client.js'),'@deepseek-ai/dsh-client-ui-chat/lib/client.js','DSHConversationActions',['installConversationActions'],true],
  [path.join(overlayRoot,'@deepseek-ai/dsh-session/lib/conversation-edit.js'),'@deepseek-ai/dsh-client-ui-conversation/lib/client.js','DSHConversationEdits',['projectConversationEntries'],false]
 ]){
  const source=await readFile(input,'utf8');if(/^import\s/m.test(source))throw Error('Browser helper must remain self contained');
  const bundle=`var ${name}=(()=>{\n${source.replace(/^export (?=(?:function|const|class) )/gm,'')}\nreturn {${exports.join(',')}};})();\n`;
  new vm.Script(bundle);const file=path.join(overlayRoot,output);let code=await readFile(file,'utf8');
  const marker=`/* ${name} maintained begin */`,end=`/* ${name} maintained end */`;
  const injected=marker+'\n'+bundle+(boot?name+'.installConversationActions();\n':'')+end;
  if(code.includes(marker)){
   const a=code.indexOf(marker),b=code.indexOf(end,a);
   if(b<0||code.split(marker).length!==2||code.split(end).length!==2)throw Error('Malformed maintained boundary');
   code=code.slice(0,a)+injected+code.slice(b+end.length);
  }else{
   const anchor='var module = { exports: {} };';if(code.split(anchor).length!==2)throw Error('Unsupported reviewed client bundle');
   code=code.replace(anchor,anchor+'\n'+injected);
  }
  new vm.Script(code);plans.push({file,code});
 }
 for(const {file,code} of plans)await writeFile(file,code);
 return plans.map(x=>x.file);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(await realpath(process.argv[1])).href)await buildConversationActions();
