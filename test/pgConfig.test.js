const { test } = require('node:test');
const assert = require('node:assert');
const pgConfig = require('../src/db/pgConfig');
const silent = { info(){}, warn(){}, error(){} };

function clean(){ for (const k of Object.keys(process.env)) if (/^(GW|AUTH)_/.test(k)) delete process.env[k]; }

test('password from <PREFIX>_PG_PASSWORD, not from the URL', () => {
  clean();
  process.env.GW_DATABASE_URL='postgresql://root_admin@13.234.135.5:5432/gateway';
  process.env.GW_PG_PASSWORD='s3cret';
  const b = pgConfig.build('GW',{logger:silent});
  assert.strictEqual(b.config.password,'s3cret');
  assert.ok(!b.url.includes('s3cret'), 'URL must not carry the secret');
});

test('<PREFIX>_PG_PASSWORD OVERRIDES a password embedded in the URL', () => {
  clean();
  process.env.GW_DATABASE_URL='postgresql://root_admin:in-url@13.234.135.5:5432/gateway';
  process.env.GW_PG_PASSWORD='wins';
  const b = pgConfig.build('GW',{logger:silent});
  assert.strictEqual(b.config.password,'wins');
});

test('the two blocks are independent', () => {
  clean();
  process.env.GW_DATABASE_URL='postgresql://root_admin@13.234.135.5:5432/gateway';
  process.env.GW_PG_PASSWORD='app-pw'; process.env.GW_PG_POOL_MAX='10';
  process.env.AUTH_DATABASE_URL='postgresql://gw_auth_ro@13.234.135.5:5432/uat_ananta_staging';
  process.env.AUTH_PG_PASSWORD='auth-pw'; process.env.AUTH_PG_POOL_MAX='5';
  const gw = pgConfig.build('GW',{logger:silent});
  const au = pgConfig.build('AUTH',{logger:silent});
  assert.strictEqual(gw.config.password,'app-pw');
  assert.strictEqual(au.config.password,'auth-pw');
  assert.strictEqual(gw.config.max,10);
  assert.strictEqual(au.config.max,5);
  assert.strictEqual(pgConfig.describe(gw.url),'13.234.135.5:5432/gateway');
  assert.strictEqual(pgConfig.describe(au.url),'13.234.135.5:5432/uat_ananta_staging');
});

test('SSL on by default, off only when asked', () => {
  clean();
  process.env.GW_DATABASE_URL='postgresql://u@h:5432/d';
  assert.deepStrictEqual(pgConfig.build('GW',{logger:silent}).config.ssl,{rejectUnauthorized:true});
  process.env.GW_PG_SSL='false';
  assert.strictEqual(pgConfig.build('GW',{logger:silent}).config.ssl,false);
});

test('no URL configured returns null rather than a broken config', () => {
  clean();
  assert.strictEqual(pgConfig.build('AUTH',{logger:silent}), null);
});

test('legacy DATABASE_URL still works as a fallback', () => {
  clean();
  process.env.DATABASE_URL='postgresql://u@h:5432/legacy';
  const b = pgConfig.build('GW',{fallbackUrlVars:['DATABASE_URL'],logger:silent});
  assert.strictEqual(b.source,'DATABASE_URL');
  delete process.env.DATABASE_URL;
});

test('describe() never leaks the password', () => {
  assert.strictEqual(pgConfig.describe('postgresql://u:TOPSECRET@13.234.135.5:5432/gateway'),'13.234.135.5:5432/gateway');
});
