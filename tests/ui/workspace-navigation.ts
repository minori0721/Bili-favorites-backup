import type {Locator,Page} from '@playwright/test';

const labels:Record<string,string>={overview:'概览',library:'归档库',subscriptions:'UP 订阅',tasks:'任务',accounts:'账号',settings:'设置'};
export async function navigate(page:Page,key:string){
  await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:labels[key]||key,exact:true}).click();
}
export async function chooseSetting(page:Page,label:string){
  await navigate(page,'settings');
  const picker=page.getByRole('combobox',{name:'设置分类'});
  if(await picker.isVisible())await picker.selectOption({label});
  else await page.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name:label,exact:true}).click();
}
/** Existing feature regressions use the same visible navigation as a user. */
export async function revealControl(page:Page,control:Locator):Promise<Locator>{
  if(await control.isVisible())return control;
  const context=await control.evaluate(element=>{
    const fold=element.closest('.settings-fold');
    return {
      page:element.closest('#settingsSection')?'settings':element.closest('.account-section')?'accounts':element.closest('#upSubscriptionsSection')?'subscriptions':element.closest('.workspace-task-panel')?'tasks':element.closest('.workspace-overview')?'overview':null,
      category:fold?.querySelector('summary')?.textContent|| (element.closest('.workspace-maintenance-group')?'维护与迁移':null),
      menu:element.closest('details.workspace-more')!==null,
    };
  });
  if(context.page)await navigate(page,context.page);
  if(context.category)await chooseSetting(page,context.category);
  if(context.menu)await control.locator('xpath=ancestor::details[1]').locator('summary').click();
  return control;
}
/** Replaces opening/closing an old settings fold with selecting the visible category. */
export async function toggleSetting(page:Page,id:string){
  const fold=page.locator('#'+id);
  const hidden=await fold.evaluate(element=>element instanceof HTMLElement&&element.hidden);
  const label=(await fold.locator('summary').textContent())!.trim();
  await chooseSetting(page,hidden?label:label==='同步节奏'?'远端存储与播放':'同步节奏');
}
