import assert from 'node:assert/strict';
export const setupSheetId = 'created_sheet_1234567890';
export const setupScriptId = 'created_script_1234567890';
export const setupDeploymentId = 'created_deployment_1234567890';
export const setupEmail = 'owner@example.test';

export function setupFixture() {
  const state = { calls: [], values: null, deployments: [], versions: 0, files: [], owned: true, parent: setupSheetId,
    loseProject: false, loseDeployment: false, failCheckpoint: false, badService: false, deny: false };
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
  state.authorize = () => { state.values[2][1] = JSON.parse(state.values[1][1]).installId; };
  state.fetchImpl = async (url, options) => {
    state.calls.push({ url, ...options });
    const target = new URL(url), method = options.method, body = options.body ? JSON.parse(options.body) : null;
    if (target.hostname === 'script.google.com') {
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.credentials, 'omit');
      const setup = JSON.parse(state.values[1][1]);
      assert.equal(body.token, body.action === 'sync' ? setup.memberToken : setup.submissionToken);
      return response({ protocol: 'cp-group', version: 1, ok: true, group: { id: setup.groupId, name: setup.name },
        sheetId: state.badService ? 'wrong_sheet_123456' : setupSheetId, consoleVersion: 1,
        capabilities: { memberSubmissions: true }, complete: true, prayers: [], revision: 'fixture_revision' });
    }
    assert.equal(options.headers.Authorization, 'Bearer test-setup-token');
    assert.equal(options.redirect, 'error');
    if (state.deny) return response({ error: { message: 'PRIVATE SERVER DETAIL' } }, 403);
    if (url === 'https://sheets.googleapis.com/v4/spreadsheets') {
      assert.equal(method, 'POST'); state.sheetPayload = body;
      state.values = body.sheets.find(sheet => sheet.properties.title === 'GroupSetup').data[0].rowData.map(row => row.values.map(cell => cell.userEnteredValue.stringValue));
      return response({ spreadsheetId: setupSheetId });
    }
    if (target.pathname.endsWith('/values:batchUpdate')) {
      if (state.failCheckpoint) { state.failCheckpoint = false; throw new TypeError('Lost checkpoint'); }
      assert.equal(body.valueInputOption, 'RAW');
      for (const update of body.data) {
        if (update.range === 'GroupSetup!A1:B2') state.values.splice(0, 2, ...update.values);
        else if (update.range === 'ConsoleSettings!A1:B6') state.settings = update.values;
        else assert.fail(`Unexpected range ${update.range}`);
      }
      return response({});
    }
    if (target.pathname.endsWith('/values/GroupSetup!A1:B3')) return response({ values: state.values });
    if (target.hostname === 'www.googleapis.com') return response({ ownedByMe: state.owned, trashed: false });
    if (url === 'https://script.googleapis.com/v1/projects') {
      assert.equal(body.parentId, setupSheetId);
      if (state.loseProject) throw new TypeError('Lost project response');
      return response({ scriptId: setupScriptId });
    }
    if (target.pathname === `/v1/projects/${setupScriptId}`) return response({ scriptId: setupScriptId, parentId: state.parent });
    if (target.pathname.endsWith('/content')) { state.files = body.files; return response({ files: body.files }); }
    if (target.pathname.endsWith('/versions')) return response({ versionNumber: ++state.versions });
    if (target.pathname.endsWith('/deployments')) {
      if (method === 'GET') return response({ deployments: state.deployments });
      state.deployments.push({ deploymentId: setupDeploymentId, deploymentConfig: body });
      if (state.loseDeployment) { state.loseDeployment = false; throw new TypeError('Lost deployment response'); }
      return response(state.deployments[0]);
    }
    if (target.pathname.endsWith(`/deployments/${setupDeploymentId}`)) {
      assert.equal(method, 'PUT'); state.deployments[0].deploymentConfig = body.deploymentConfig;
      return response(state.deployments[0]);
    }
    assert.fail(`Unexpected setup call: ${method} ${url}`);
  };
  return state;
}
