import {assert} from '../common.js';
import {permissionCatalogFor} from './permissions.js';
import {sharedControllerEndpoints} from './routes.js';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max=500)=>typeof value==='string'&&value.length>0&&value.length<=max;
const identifier=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(value);
const key=value=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value)&&!value.split('.').some(part=>['__proto__','constructor','prototype'].includes(part));
const components=new Set(['overview','resource','table','logs','settings','backups','accounts','mod-library','diagnostics','operations','extension']);
const formats=new Set(['text','bytes','percent','integer','minutes']);
function keys(value,allowed,owner){
  assert(object(value)&&Object.keys(value).every(name=>allowed.includes(name)),`Unsupported ${owner} field.`);
}
function jsonOnly(value,depth=0){
  assert(depth<=16,'Application presentation is too deeply nested.');
  if(value===null||['string','boolean'].includes(typeof value))return;
  if(typeof value==='number'){assert(Number.isFinite(value),'Invalid presentation number.');return;}
  assert(Array.isArray(value)||object(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value)),'Presentation must contain JSON data only.');
  for(const [name,item] of Object.entries(value)){
    assert(!['__proto__','constructor','prototype'].includes(name),'Unsafe presentation key.');
    jsonOnly(item,depth+1);
  }
}
function confirmation(value){
  keys(value,['title','message'],'confirmation');assert(text(value.title,100)&&text(value.message,1000),'Invalid action confirmation.');
}
function actionFields(fields){
  assert(Array.isArray(fields)&&fields.length>0&&fields.length<=16&&new Set(fields.map(field=>field.key)).size===fields.length,'Invalid action form fields.');
  for(const field of fields){
    keys(field,['key','label','type','min','max','required','choices','placeholder'],'action field');
    assert(key(field.key)&&!field.key.includes('.')&&text(field.label,100)&&['text','textarea','number','boolean','select'].includes(field.type),'Invalid action field.');
    assert(field.required===undefined||typeof field.required==='boolean','Invalid action field requirement.');
    if(field.type==='number')assert(Number.isInteger(field.min)&&Number.isInteger(field.max)&&field.min<=field.max,'Action numeric fields need bounded ranges.');
    else if(['text','textarea'].includes(field.type))assert(Number.isInteger(field.max)&&field.max>0&&field.max<=65536,'Action text fields need bounded lengths.');
    else if(field.type==='select'){
      assert(Array.isArray(field.choices)&&field.choices.length>0&&field.choices.length<=64,'Invalid action choices.');
      const seen=new Set();for(const choice of field.choices){keys(choice,['value','label'],'action choice');assert(text(choice.value,250)&&text(choice.label,100)&&!seen.has(choice.value),'Invalid action choice.');seen.add(choice.value);}
    }
    assert(field.placeholder===undefined||text(field.placeholder,250),'Invalid action placeholder.');
  }
}
function forms(values,action){
  assert(Array.isArray(values)&&values.length<=8&&new Set(values.map(value=>value.id)).size===values.length,'Invalid action forms.');
  for(const value of values){
    keys(value,['id','heading','description','action','fields','submitLabel','resultId','confirmation','availability'],'action form');
    assert(identifier(value.id)&&text(value.heading,100)&&text(value.submitLabel,100)&&(!value.resultId||identifier(value.resultId)),'Invalid action form.');
    assert(!value.resultId||!['logs','settings','server-name','game-address','page-title','jobs','auth'].includes(value.resultId)&&!values.some(other=>other.id===value.resultId||other!==value&&other.resultId===value.resultId),'Conflicting action result ID.');
    assert(value.description===undefined||text(value.description,1000),'Invalid action form description.');
    assert(value.availability===undefined||['always','ready','running','stopped'].includes(value.availability),'Invalid action availability.');
    action(value.action);actionFields(value.fields);if(value.confirmation)confirmation(value.confirmation);
  }
}

// This is the presentation part of an application definition. Only bundled,
// reviewed packages are admitted. Descriptors select fixed shared components;
// they cannot supply HTML, JS expressions, import paths or host operations.
export function validateApplicationPresentation(module){
  const presentation=module.presentation;
  if(!presentation)return;
  jsonOnly(presentation);
  keys(presentation,['version','id','revision','kind','screens','confirmations','onboarding'],'presentation');
  assert(presentation.version===1&&presentation.id===module.id&&Number.isInteger(presentation.revision)&&presentation.revision>0&&['game','application','service'].includes(presentation.kind),'Invalid application presentation identity.');
  assert(Array.isArray(presentation.screens)&&presentation.screens.length>0&&presentation.screens.length<=32,'Invalid application screens.');
  assert(new Set(presentation.screens.map(screen=>screen.id)).size===presentation.screens.length,'Duplicate application screens.');
  const source=route=>assert(typeof route==='string'&&Object.hasOwn({...sharedControllerEndpoints,...module.contract.routes},route)&&Object.hasOwn((module.contract.routes[route]||sharedControllerEndpoints[route]),'GET'),'Screen source must be a declared GET endpoint.');
  const action=name=>assert(typeof name==='string'&&Object.hasOwn(module.contract.actions,name),'Screen references an undeclared action.');
  const catalog=permissionCatalogFor(module),validPermission=value=>value==='account.self'||Object.hasOwn(catalog,value);
  const all=[];
  for(const parent of presentation.screens){
    assert(parent.routes===undefined||Array.isArray(parent.routes)&&parent.routes.length<=8&&new Set(parent.routes.map(child=>child.id)).size===parent.routes.length,'Invalid application section routes.');
    all.push(parent,...(parent.routes||[]));
    for(const child of parent.routes||[])assert(child.routes===undefined&&child.subroutes===undefined,'Application sections cannot nest further.');
  }
  for(const screen of all){
    keys(screen,['id','label','component','permission','permissionsAny','adminOnly','ownerOnly','feature','actions','options','routes','subroutes','contentPermission'],'screen');
    assert(identifier(screen.id)&&text(screen.label,100)&&components.has(screen.component),'Unknown application component.');
    assert(screen.options===undefined||object(screen.options),'Invalid component options.');
    for(const flag of ['adminOnly','ownerOnly'])assert(screen[flag]===undefined||typeof screen[flag]==='boolean','Invalid screen access flag.');
    for(const name of ['permission','contentPermission'])assert(screen[name]===undefined||typeof screen[name]==='string'&&validPermission(screen[name]),'Invalid application screen permission.');
    assert(screen.permissionsAny===undefined||Array.isArray(screen.permissionsAny)&&screen.permissionsAny.length>0&&screen.permissionsAny.every(value=>typeof value==='string'&&validPermission(value)),'Invalid application screen permission list.');
    assert(screen.feature===undefined||module.contract.features?.[screen.feature]===true,'Screen requires an unavailable application feature.');
    assert(screen.subroutes===undefined||screen.component==='extension'&&Array.isArray(screen.subroutes)&&screen.subroutes.length<=16&&screen.subroutes.every(identifier)&&new Set(screen.subroutes).size===screen.subroutes.length&&!screen.subroutes.some(path=>(screen.routes||[]).some(route=>route.id===path)),'Invalid extension subroutes.');
    const options=screen.options||{};
    if(screen.actions){assert(Array.isArray(screen.actions)&&screen.actions.length<=16,'Invalid screen actions.');screen.actions.forEach(action);}
    if(['overview','resource','table'].includes(screen.component)){
      keys(options,['source','fields','empty','heading','actionLabels','actionAvailability',...(screen.component==='table'?['collection','refreshLabel','availableKey','messageKey','forms','rowActions']:[])],'data component');
      if(screen.component!=='overview')source(options.source);
      else assert(options.source===undefined,'Overview uses the common status model.');
      assert(Array.isArray(options.fields)&&options.fields.length<=16,'Invalid component fields.');
      const seen=new Set(),ids=new Set();
      for(const field of options.fields){
        keys(field,['key','label','format','id'],'display field');
        assert(key(field.key)&&text(field.label,100)&&(!field.format||formats.has(field.format))&&(!field.id||identifier(field.id))&&!seen.has(field.key),'Invalid display field.');seen.add(field.key);
        if(field.id){assert(!ids.has(field.id)&&!['server-name','game-address','jobs','page-title','settings-note','settings','logs','auth'].includes(field.id),'Conflicting display field ID.');ids.add(field.id);}
      }
      for(const name of ['empty','heading'])assert(options[name]===undefined||text(options[name]),'Invalid component text.');
      if(screen.component==='table'){
        assert(key(options.collection)&&text(options.refreshLabel,100),'Invalid table component.');
        for(const name of ['availableKey','messageKey'])assert(options[name]===undefined||key(options[name]),'Invalid table response key.');
        if(options.forms)forms(options.forms,action);
        if(options.rowActions){
          assert(Array.isArray(options.rowActions)&&options.rowActions.length<=8,'Invalid row actions.');
          for(const row of options.rowActions){
            keys(row,['label','action','params','bindings','confirmation'],'row action');assert(text(row.label,100)&&object(row.params)&&object(row.bindings),'Invalid row action.');action(row.action);
            assert(Object.keys({...row.params,...row.bindings}).every(value=>key(value)&&!value.includes('.'))&&Object.values(row.params).every(value=>['string','number','boolean'].includes(typeof value))&&Object.values(row.bindings).every(key),'Invalid row action parameters.');
            if(row.confirmation)confirmation(row.confirmation);
          }
        }
      }
      {
        for(const name of ['actionLabels','actionAvailability'])if(options[name]){
          assert(object(options[name]),'Invalid component action metadata.');
          for(const [id,value] of Object.entries(options[name]))assert(screen.actions?.includes(id)&&(name==='actionLabels'?text(value,100):['always','ready','running','stopped'].includes(value)),'Invalid component action metadata.');
        }
      }
    }else if(screen.component==='settings'){
      keys(options,['source','action','valuesKey','paramsKey','revisionKey','requiresStopped','submitLabel','description','fields','formId'],'settings component');
      source(options.source);action(options.action);
      assert(module.contract.policy.routes[options.source]?.GET==='settings.read'&&module.contract.actions[options.action].permission==='settings.write','Settings must retain shared read/write permissions.');
      for(const name of ['valuesKey','paramsKey','revisionKey'])assert(options[name]===undefined||key(options[name])&&!options[name].includes('.'),'Invalid settings envelope key.');
      assert(options.requiresStopped===undefined||typeof options.requiresStopped==='boolean','Invalid settings stop policy.');
      assert(text(options.submitLabel,100)&&text(options.description)&&identifier(options.formId),'Invalid settings component text.');
      assert(Array.isArray(options.fields)&&options.fields.length>0&&options.fields.length<=64,'Invalid settings fields.');
      const seen=new Set();
      for(const field of options.fields){
        keys(field,['key','label','type','min','max','default','required','placeholder','help','visibleWhen'],'settings field');
        assert(key(field.key)&&text(field.label,100)&&['text','textarea','number','boolean','password'].includes(field.type)&&!seen.has(field.key),'Invalid settings field.');seen.add(field.key);
        assert(field.required===undefined||typeof field.required==='boolean','Invalid field requirement.');
        assert(field.default===undefined||['string','number','boolean'].includes(typeof field.default),'Invalid field default.');
        assert(field.type!=='password'||field.default===undefined||field.default==='','Password defaults cannot be public.');
        for(const name of ['min','max'])assert(field[name]===undefined||Number.isInteger(field[name]),'Invalid field limit.');
        assert(field.min===undefined||field.max===undefined||field.min<=field.max,'Invalid field range.');
        if(field.type==='number'){
          assert(Number.isInteger(field.min)&&Number.isInteger(field.max),'Numeric fields need bounded ranges.');
          assert(field.default===undefined||Number.isInteger(field.default)&&field.default>=field.min&&field.default<=field.max,'Invalid numeric field default.');
        }else if(field.type==='boolean'){
          assert(field.default===undefined||typeof field.default==='boolean','Invalid boolean field default.');
        }else{
          assert(field.min===undefined&&Number.isInteger(field.max)&&field.max>0&&field.max<=65536,'Text fields need a bounded length.');
          assert(field.default===undefined||typeof field.default==='string'&&field.default.length<=field.max,'Invalid text field default.');
        }
        for(const name of ['placeholder','help'])assert(field[name]===undefined||text(field[name]),'Invalid field help.');
        assert(field.visibleWhen===undefined||key(field.visibleWhen),'Invalid field visibility flag.');
      }
    }else if(screen.component==='logs'){
      keys(options,['source','key','description','forms'],'logs component');source(options.source);
      assert(key(options.key)&&text(options.description),'Invalid logs component.');
      if(options.forms)forms(options.forms,action);
    }else if(screen.component==='backups'){
      assert(module.contract.features.backups===true,'Backups component requires backup support.');
      // The shell owns the page title. Retain showHeading in older fingerprinted definitions.
      keys(options,['description','restore','showHeading'],'backup component');assert(text(options.description),'Invalid backup description.');
      for(const flag of ['restore','showHeading'])assert(options[flag]===undefined||typeof options[flag]==='boolean','Invalid backup display flag.');
      assert(!options.restore||Object.hasOwn(module.contract.actions,'restore'),'Restore needs a declared action.');
    }else if(screen.component==='accounts'){
      keys(options,['showHeading'],'account component');assert(options.showHeading===undefined||typeof options.showHeading==='boolean','Invalid account display flag.');
    }else if(screen.component==='mod-library'){
      keys(options,['description'],'mod library component');assert(text(options.description),'Invalid mod library description.');
      source('/mod-library');action('mod-library-install');assert(module.contract.features.mods===true,'Mod library requires declared mod support.');
    }else if(screen.component==='operations'){
      keys(options,[],'operations component');assert(screen.adminOnly===true&&!screen.permission&&!screen.permissionsAny,'Operation history requires administrator-only presentation.');
    }else if(screen.component==='diagnostics'){
      keys(options,[],'diagnostics component');assert(screen.adminOnly===true&&!screen.permission&&!screen.permissionsAny,'Diagnostics requires administrator-only presentation.');
    }else if(screen.component==='extension'){
      keys(options,['provider','version','requiresStatus'],'extension component');
      assert(typeof options.provider==='string'&&/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(options.provider)&&options.version===1,'Invalid capability extension.');
      const extension=module.web.extensions?.[options.provider];
      assert(extension?.version===options.version&&module.web.assets[extension.script]?.[1].startsWith('text/javascript')&&module.web.assets[extension.template]?.[1].startsWith('text/html'),'Extension needs reviewed script and template assets.');
      assert(options.requiresStatus===undefined||typeof options.requiresStatus==='boolean','Invalid extension status requirement.');
    }else keys(options,[],'account component');
  }
  assert(JSON.stringify(presentationScreens(presentation))===JSON.stringify(module.contract.screens),'Application navigation differs from its definition.');
  if(presentation.confirmations){
    assert(object(presentation.confirmations),'Invalid application confirmations.');
    for(const [name,message] of Object.entries(presentation.confirmations)){
      action(name);confirmation(message);
      assert(module.contract.actions[name].confirmation&&text(message.title,100)&&text(message.message,1000),'Invalid action confirmation.');
    }
  }
  if(presentation.onboarding){
    keys(presentation.onboarding,['screen','resumeLabel'],'onboarding');
    assert(presentation.screens.some(screen=>screen.id===presentation.onboarding.screen&&screen.adminOnly===true)&&text(presentation.onboarding.resumeLabel,100),'Invalid application onboarding screen.');
  }
}

export function presentationScreens(presentation){
  return presentation.screens.map(({component:_component,options:_options,routes:_routes,subroutes:_subroutes,contentPermission:_contentPermission,...navigation})=>navigation);
}
