import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  buildElementWebConfig,
  ensureElementWebBundle,
  startElementWebServer,
} from '../../packages/testing/src/browser-harness.mjs';
import {
  eventually,
} from './support.mjs';

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function buildTimelineFilePattern(fileName) {
  const extension = path.extname(fileName);
  const baseName = path.basename(fileName, extension);
  const visiblePrefix = escapeRegExp(baseName.slice(0, Math.min(baseName.length, 15)));
  const visibleSuffix = extension.length === 0 ? '' : `.*${escapeRegExp(extension)}`;
  return new RegExp(
    `${visiblePrefix}${visibleSuffix}(?:\\s*\\(\\d+(?:\\.\\d+)?\\s*[KMGT]?B\\))?`,
    'iu',
  );
}

function relativeArtifactPath(artifactRoot, artifactPath) {
  return path.relative(artifactRoot, artifactPath).replaceAll(path.sep, '/');
}

function normalizeRoomEntryLabel(value) {
  const text = normalizeText(value);
  if (text.length === 0) {
    return null;
  }
  const stripped = text
    .replace(/^Open room /iu, '')
    .replace(/\s+invitation\.?$/iu, '')
    .trim();
  return stripped.length === 0 ? null : stripped;
}

async function countVisible(locator) {
  try {
    return await locator.count();
  } catch {
    return 0;
  }
}

async function firstVisibleTarget(locator) {
  const count = await countVisible(locator);
  for (let index = 0; index < count; index += 1) {
    try {
      const candidate = locator.nth(index);
      if (await candidate.isVisible()) {
        return candidate;
      }
    } catch {
      // Ignore a stale/hidden candidate and continue scanning the locator list.
    }
  }
  return null;
}

async function isVisible(locator) {
  return await firstVisibleTarget(locator) != null;
}

async function hasAppShellVisible(page) {
  const userMenu = page.getByRole('button', { name: 'User menu' });
  if (await isVisible(userMenu)) {
    return true;
  }

  const homeHeading = page.getByRole('heading', { name: 'Home' });
  if (await isVisible(homeHeading)) {
    return true;
  }

  const newConversation = page.getByRole('button', { name: 'New conversation' });
  if (await isVisible(newConversation)) {
    return true;
  }

  const searchBox = page.locator('input[placeholder="Search"], input[aria-label="Search"]').first();
  return isVisible(searchBox);
}

async function safeClickFirstVisible(locators) {
  for (const locator of locators) {
    const visibleTarget = await firstVisibleTarget(locator);
    if (visibleTarget == null) {
      continue;
    }
    const clickAttempts = [
      async () => visibleTarget.click(),
      async () => safeClick(locator),
      async () => visibleTarget.dispatchEvent('click'),
      async () => visibleTarget.evaluate((node) => node.click()),
    ];
    for (const clickAttempt of clickAttempts) {
      try {
        await clickAttempt();
        return true;
      } catch {
        // Try the next click strategy before giving up on this locator.
      }
    }
  }
  return false;
}

export function createBrowserJourneyRecorder() {
  const results = new Map();

  return {
    pass(journeyId, {
      artifacts = [],
      notes = null,
    } = {}) {
      results.set(journeyId, {
        journey_id: journeyId,
        status: 'pass',
        artifacts,
        notes,
      });
    },

    fail(journeyId, error, {
      artifacts = [],
      notes = null,
    } = {}) {
      results.set(journeyId, {
        journey_id: journeyId,
        status: 'fail',
        artifacts,
        notes: notes ?? (error instanceof Error ? error.message : String(error)),
      });
    },

    toArray() {
      return [...results.values()];
    },
  };
}

export async function ensureBrowserArtifactRoot(rootPath) {
  const resolved = path.resolve(rootPath);
  await fs.mkdir(resolved, { recursive: true });
  return resolved;
}

export async function writeJourneyScreenshot(page, artifactRoot, journeyId, label) {
  const fileName = `${journeyId.toLowerCase()}-${label}.png`;
  const destination = path.join(artifactRoot, fileName);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await page.screenshot({
    path: destination,
    fullPage: true,
  });
  return relativeArtifactPath(artifactRoot, destination);
}

export async function startElementBrowserHarness(remoteHarness, {
  cacheRoot = undefined,
  forceVerification = false,
} = {}) {
  const bundle = await ensureElementWebBundle(cacheRoot);
  const server = await startElementWebServer({
    webRoot: bundle.web_root,
    config: buildElementWebConfig({
      homeserverBaseUrl: remoteHarness.baseUrl,
      serverName: remoteHarness.serverName,
      forceVerification,
    }),
  });
  return {
    bundle,
    server,
    appBaseUrl: server.base_url,
  };
}

export function buildUiAccount(prefix, {
  deviceId,
  password,
} = {}) {
  const username = (
    `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  )
    .toLowerCase()
    .replace(/[^a-z0-9._=-]/gu, '-')
    .slice(0, 24);
  return {
    username,
    password: password ?? `phase08-element-e2e-${prefix}-password`,
    deviceId: deviceId ?? `${prefix}`.toUpperCase().replace(/[^A-Z0-9]/gu, '').slice(0, 10),
  };
}

export function asUserId(username, serverName) {
  return `@${username}:${serverName}`;
}

export async function safeClick(locator) {
  const target = await eventually(async () => {
    const visibleTarget = await firstVisibleTarget(locator);
    assert.ok(visibleTarget, 'unable to locate a visible click target');
    return visibleTarget;
  }, {
    attempts: 30,
    delayMs: 250,
  });
  const attempts = [
    async () => target.click(),
    async () => target.dispatchEvent('click'),
    async () => target.evaluate((node) => node.click()),
  ];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      await attempt();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function dismissForegroundPrompts(page, {
  preserveVerification = false,
} = {}) {
  for (let index = 0; index < 6; index += 1) {
    const dismissButton = page.getByRole('button', { name: 'Dismiss' });
    if (await isVisible(dismissButton)) {
      try {
        await safeClick(dismissButton);
      } catch {
        await page.waitForTimeout(200);
      }
      await page.waitForTimeout(400);
      continue;
    }
    if (!preserveVerification) {
      const bodyText = normalizeText(await page.textContent('body').catch(() => ''));
      const verificationPromptVisible = /Verify this session|Start verification on the other device|You need to verify this device|Verification requested|Confirm your identity/iu.test(bodyText);
      const verifyLater = page.getByRole('button', { name: /Skip verification for now|I'll verify later|Later/iu });
      if (await isVisible(verifyLater)) {
        try {
          await safeClick(verifyLater);
        } catch {
          await page.waitForTimeout(200);
        }
        await page.waitForTimeout(400);
        continue;
      }
      if (verificationPromptVisible) {
        const closedVerificationPrompt = await safeClickFirstVisible([
          page.getByRole('button', { name: /Close dialog|Close|Not now/iu }),
          page.locator('#mx_Dialog_StaticContainer button[aria-label="Close dialog"]'),
          page.locator('#mx_Dialog_StaticContainer .mx_Dialog_header button'),
        ]);
        if (closedVerificationPrompt) {
          await page.waitForTimeout(400);
          continue;
        }
      }
    }
    break;
  }
}

export async function waitForAppReady(page) {
  const userMenu = page.getByRole('button', { name: 'User menu' });
  const searchBox = page.locator('input[placeholder="Search"], input[aria-label="Search"]').first();
  const homeHeading = page.getByRole('heading', { name: 'Home' });
  const newConversation = page.getByRole('button', { name: 'New conversation' });
  await Promise.race([
    userMenu.waitFor({ timeout: 60_000 }),
    searchBox.waitFor({ timeout: 60_000 }),
    newConversation.waitFor({ timeout: 60_000 }),
    page.getByRole('button', { name: /Skip verification for now|I'll verify later|Later/iu }).waitFor({ timeout: 60_000 }),
    homeHeading.waitFor({ timeout: 60_000 }),
  ]);
  await dismissForegroundPrompts(page);
  await eventually(async () => {
    assert.equal(await hasAppShellVisible(page), true);
  }, {
    attempts: 120,
    delayMs: 500,
  });
}

export async function waitForPostLoginState(page, {
  allowVerificationPrompt = false,
} = {}) {
  return eventually(async () => {
    if (allowVerificationPrompt) {
      const verificationState = await readVerificationStage(page);
      if (verificationState.stage !== 'app' && verificationState.stage !== 'unknown') {
        return 'verification_prompt';
      }
    }

    if (await hasAppShellVisible(page)) {
      await dismissForegroundPrompts(page, { preserveVerification: allowVerificationPrompt });
      await eventually(async () => {
        assert.equal(await hasAppShellVisible(page), true);
      }, {
        attempts: 60,
        delayMs: 500,
      });
      return 'app';
    }

    throw new Error('post-login state has not stabilized yet');
  }, {
    attempts: 120,
    delayMs: 500,
  });
}

export async function configureCustomHomeserver(page, remoteHarness) {
  await safeClick(page.getByRole('button', { name: 'Edit' }));
  await page.locator('#mx_homeserverInput').fill(remoteHarness.baseUrl);
  await safeClick(page.getByRole('button', { name: 'Continue' }));
}

export async function registerViaUi(page, remoteHarness, {
  appBaseUrl,
  username,
  password,
} = {}) {
  assert.equal(typeof appBaseUrl, 'string');
  await page.goto(`${appBaseUrl}/#/register`, { waitUntil: 'domcontentloaded' });
  await configureCustomHomeserver(page, remoteHarness);
  const registrationResponse = page.waitForResponse((response) => (
    response.request().method() === 'POST'
      && /\/_matrix\/client\/(?:r0|v1|v3)\/register$/u.test(response.url())
      && response.ok()
  ), {
    timeout: 30_000,
  }).then(async (response) => response.json()).catch(() => null);
  const usernameInput = page.locator('input#mx_RegistrationForm_username, input[name="username"], input[placeholder="Username"]').first();
  const passwordInput = page.locator('#mx_RegistrationForm_password, input[placeholder="Password"]').first();
  const passwordConfirmInput = page.locator('#mx_RegistrationForm_passwordConfirm, input[placeholder="Confirm password"]').first();
  await usernameInput.waitFor({ state: 'visible', timeout: 30_000 });
  await usernameInput.fill(username);
  await passwordInput.fill(password);
  await passwordConfirmInput.fill(password);
  await safeClick(page.getByRole('button', { name: 'Register' }));
  await waitForAppReady(page);
  const registrationPayload = await registrationResponse;
  return {
    username,
    password,
    user_id: registrationPayload?.user_id ?? asUserId(username, remoteHarness.serverName),
    access_token: registrationPayload?.access_token ?? null,
    device_id: registrationPayload?.device_id ?? null,
    refresh_token: registrationPayload?.refresh_token ?? null,
  };
}

export async function loginViaUi(page, remoteHarness, {
  appBaseUrl,
  username,
  password,
  allowVerificationPrompt = false,
} = {}) {
  assert.equal(typeof appBaseUrl, 'string');
  await page.goto(`${appBaseUrl}/#/login`, { waitUntil: 'domcontentloaded' });
  await configureCustomHomeserver(page, remoteHarness);
  const loginResponse = page.waitForResponse((response) => (
    response.request().method() === 'POST'
      && /\/_matrix\/client\/(?:r0|v1|v3)\/login$/u.test(response.url())
  ), {
    timeout: 60_000,
  }).then(async (response) => ({
    status: response.status(),
    payload: response.headers()['content-type']?.includes('application/json')
      ? await response.json().catch(() => null)
      : await response.text().catch(() => null),
  })).catch(() => null);
  const usernameInput = page.locator('input#mx_LoginForm_username, input[name="username"], input[autocomplete="username"], input[placeholder="Username"]').first();
  const passwordInput = page.locator('#mx_LoginForm_password, input[placeholder="Password"], input[type="password"]').first();
  await usernameInput.waitFor({ state: 'visible', timeout: 30_000 });
  await usernameInput.fill(username);
  await passwordInput.fill(password);
  await safeClick(page.getByRole('button', { name: 'Sign in' }));
  const loginResult = await loginResponse;
  assert.ok(loginResult, 'expected a Matrix /login response after submitting the Element sign-in form');
  assert.equal(
    loginResult.status,
    200,
    `expected a successful Matrix /login response, received ${loginResult.status} ${typeof loginResult.payload === 'string' ? loginResult.payload : JSON.stringify(loginResult.payload)}`,
  );
  await waitForPostLoginState(page, { allowVerificationPrompt });
  return loginResult.payload;
}

export async function navigateHome(page, appBaseUrl) {
  let navigated = false;
  await dismissForegroundPrompts(page).catch(() => {});
  const homeViaUi = await safeClickFirstVisible([
    page.getByRole('button', { name: /^Home$/iu }),
    page.getByRole('link', { name: /^Home$/iu }),
    page.locator('a[href="#/home"], a[href*="/#/home"]'),
    page.locator('[aria-label="Home"]'),
  ]);
  if (homeViaUi) {
    navigated = true;
  } else {
    navigated = await page.evaluate(() => {
      if (window.location.hash === '#/home') {
        return true;
      }
      window.location.hash = '#/home';
      return true;
    }).catch(() => false);
  }
  if (!navigated) {
    await page.goto(`${appBaseUrl}/#/home`, { waitUntil: 'domcontentloaded' });
  }
  await waitForAppReady(page);
}

export async function createPrivateRoom(page, roomName, {
  encrypted = true,
} = {}) {
  await dismissForegroundPrompts(page);
  const directNewRoom = page.getByRole('button', { name: 'New room' });
  if (await isVisible(directNewRoom)) {
    await safeClick(directNewRoom);
  } else {
    await safeClick(page.getByRole('button', { name: 'New conversation' }));
    await safeClick(page.getByRole('menuitem', { name: 'New room' }));
  }
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(roomName);
  const encryptionControl = await firstVisibleTarget(
    dialog.getByRole('checkbox', { name: /Enable end-to-end encryption/iu }),
  ) ?? await firstVisibleTarget(
    dialog.getByRole('switch', { name: /Enable end-to-end encryption/iu }),
  ) ?? await firstVisibleTarget(
    dialog.getByLabel(/Enable end-to-end encryption/iu),
  );
  if (encryptionControl != null) {
    const isCurrentlyEncrypted = await encryptionControl.isChecked().catch(async () => (
      (await encryptionControl.getAttribute('aria-checked').catch(() => null)) === 'true'
    ));
    if (Boolean(isCurrentlyEncrypted) !== encrypted) {
      await safeClick(encryptionControl);
    }
  } else if (!encrypted) {
    throw new Error('unable to locate the room encryption toggle for unencrypted room creation');
  }
  await safeClick(dialog.getByRole('button', { name: /Create room/iu }));
  await eventually(async () => {
    assert.equal(await page.getByText(roomName, { exact: true }).count() > 0, true);
  }, {
    attempts: 120,
    delayMs: 500,
  });
  await eventually(async () => {
    const bodyText = await page.textContent('body');
    if (encrypted) {
      assert.match(bodyText ?? '', /Messages in this room are end-to-end encrypted/iu);
      return;
    }
    assert.doesNotMatch(bodyText ?? '', /Messages in this room are end-to-end encrypted/iu);
  }, {
    attempts: 20,
    delayMs: 250,
  });
  await dismissForegroundPrompts(page);
}

export async function openRoomByName(page, roomName, {
  invitation = false,
} = {}) {
  return openRoomByCandidates(page, [roomName], { invitation });
}

export async function openRoomByCandidates(page, roomNames, {
  invitation = false,
} = {}) {
  const patterns = [];
  for (const roomName of roomNames) {
    if (typeof roomName !== 'string' || roomName.trim().length === 0) {
      continue;
    }
    const escaped = escapeRegExp(roomName);
    if (invitation) {
      patterns.push(
        new RegExp(`Open room ${escaped} invitation\\.?`, 'iu'),
        new RegExp(`${escaped}`, 'iu'),
      );
    } else {
      patterns.push(
        new RegExp(`Open room ${escaped}(?: invitation\\.)?`, 'iu'),
        new RegExp(`${escaped}`, 'iu'),
      );
    }
  }
  if (patterns.length === 0) {
    throw new Error('Unable to open a room without at least one candidate label');
  }
  for (const pattern of patterns) {
    for (const role of ['option', 'button']) {
      const locator = page.getByRole(role, { name: pattern });
      if (await isVisible(locator)) {
        await safeClick(locator);
        return;
      }
    }
    const textLocator = page.getByText(pattern);
    if (await isVisible(textLocator)) {
      await safeClick(textLocator);
      return;
    }
  }
  throw new Error(`Unable to locate room list entry for ${roomNames.join(', ')}`);
}

export async function inviteUserToCurrentRoom(page, userId) {
  const inviteToRoom = page.getByRole('button', { name: 'Invite to this room' });
  if (await isVisible(inviteToRoom)) {
    await safeClick(inviteToRoom);
  } else {
    await safeClick(page.getByRole('button', { name: 'Room info' }));
    await safeClick(page.getByRole('menuitem', { name: 'Invite' }));
  }
  const dialog = page.getByRole('dialog');
  const inviteInput = (await isVisible(dialog.getByTestId('invite-dialog-input')))
    ? dialog.getByTestId('invite-dialog-input')
    : dialog.locator('.mx_InviteDialog_addressBar input[placeholder="Search"]').first();
  await inviteInput.fill(userId);
  await inviteInput.press('Enter');
  await safeClick(dialog.getByRole('button', { name: 'Invite' }));
}

export async function acceptInviteByRoomName(page, roomName) {
  await openRoomByName(page, roomName, { invitation: true });
  await safeClick(page.getByRole('button', { name: 'Accept' }));
  await eventually(async () => {
    assert.equal(await page.getByText(roomName, { exact: true }).count() > 0, true);
  }, {
    attempts: 120,
    delayMs: 500,
  });
  await dismissForegroundPrompts(page);
}

export async function sendMessage(page, message) {
  await dismissForegroundPrompts(page);
  await closeSettingsDialog(page);
  const composer = page.locator('.mx_MessageComposer');
  const textbox = composer.locator('div[contenteditable="true"][role="textbox"]').first();
  const sendResponse = page.waitForResponse((response) => (
    response.request().method() === 'PUT'
      && /\/_matrix\/client\/(?:r0|v1|v3)\/rooms\/[^/]+\/send\/m\.room\.(?:message|encrypted)\/[^/?#]+/u.test(response.url())
  ), {
    timeout: 30_000,
  }).then(async (response) => ({
    status: response.status(),
    payload: response.headers()['content-type']?.includes('application/json')
      ? await response.json().catch(() => null)
      : await response.text().catch(() => null),
  })).catch(() => null);
  await textbox.click();
  await textbox.fill(message);
  await textbox.press('Enter');
  const sendResult = await sendResponse;
  assert.ok(sendResult, `expected a Matrix /send response for message ${message}`);
  assert.equal(
    sendResult.status,
    200,
    `expected Matrix /send acceptance for message ${message}, received ${sendResult.status} ${typeof sendResult.payload === 'string' ? sendResult.payload : JSON.stringify(sendResult.payload)}`,
  );
  await waitForBodyText(page, message);
}

export async function waitForBodyText(page, text) {
  await eventually(async () => {
    const bodyText = await page.textContent('body');
    assert.match(bodyText ?? '', new RegExp(escapeRegExp(text), 'u'));
  }, {
    attempts: 120,
    delayMs: 500,
  });
}

export async function startDirectMessage(page, userId) {
  await navigateHome(page, page.url().split('/#/')[0]);
  await dismissForegroundPrompts(page).catch(() => {});
  const directMessageOpened = await safeClickFirstVisible([
    page.getByRole('button', { name: /Send a Direct Message|Direct Message/iu }),
    page.getByRole('link', { name: /Send a Direct Message|Direct Message/iu }),
    page.getByRole('button', { name: /Start chat/iu }),
  ]);
  if (!directMessageOpened) {
    await safeClickFirstVisible([
      page.getByRole('button', { name: /New conversation|Start chat/iu }),
      page.locator('button[aria-label="New conversation"], button[title="New conversation"]'),
      page.locator('button[aria-label="Start chat"], button[title="Start chat"]'),
    ]);
    await page.waitForTimeout(500);
    await safeClickFirstVisible([
      page.getByRole('menuitem', { name: /Send a Direct Message|Direct Message|New direct message|Start chat/iu }),
      page.getByRole('button', { name: /Send a Direct Message|Direct Message|New direct message|Start chat/iu }),
      page.getByText(/Send a Direct Message|Direct Message|New direct message|Start chat/iu),
    ]);
  }
  const dialog = page.getByRole('dialog');
  const searchInput = await eventually(async () => {
    const visibleSearchInput = (
      await firstVisibleTarget(dialog.locator('input[placeholder="Search"], input[aria-label="Search"]'))
    ) ?? (
      await firstVisibleTarget(page.locator('input[placeholder="Search"], input[aria-label="Search"]'))
    );
    assert.ok(visibleSearchInput, 'unable to locate the direct-message search input');
    return visibleSearchInput;
  }, {
    attempts: 60,
    delayMs: 500,
  });
  await searchInput.fill(userId);
  const userPattern = new RegExp(escapeRegExp(userId), 'iu');
  await eventually(async () => {
    assert.equal(
      await safeClickFirstVisible([
        dialog.getByRole('option', { name: userPattern }),
        dialog.getByRole('button', { name: userPattern }),
        dialog.getByText(userPattern),
        page.getByRole('option', { name: userPattern }),
        page.getByRole('button', { name: userPattern }),
        page.getByText(userPattern),
      ]),
      true,
    );
  }, {
    attempts: 60,
    delayMs: 500,
  });
  await safeClickFirstVisible([
    dialog.getByRole('button', { name: /Go|Start chat/iu }),
    dialog.getByRole('menuitem', { name: /Go|Start chat/iu }),
    page.getByRole('button', { name: /Go|Start chat/iu }),
    page.getByRole('menuitem', { name: /Go|Start chat/iu }),
  ]);
  await waitForMessageComposer(page);
  await dismissForegroundPrompts(page);
  return readSelectedRoomEntryName(page);
}

export async function readSelectedRoomEntryName(page) {
  const selectedEntry = await firstVisibleTarget(
    page.locator('[role="option"][aria-selected="true"], [role="button"][aria-selected="true"]'),
  );
  if (selectedEntry == null) {
    return null;
  }
  const ariaLabel = await selectedEntry.getAttribute('aria-label').catch(() => null);
  const textContent = await selectedEntry.textContent().catch(() => null);
  return normalizeRoomEntryLabel(ariaLabel ?? textContent);
}

export async function waitForMessageComposer(page) {
  const composer = page.locator('.mx_MessageComposer');
  await composer.waitFor({ state: 'visible', timeout: 60_000 });
}

export async function uploadFileInCurrentRoom(page, filePath) {
  const fileName = path.basename(filePath);
  await dismissForegroundPrompts(page);
  await page.locator('.mx_MessageComposer_actions input[type="file"]').setInputFiles(filePath);
  await safeClick(page.getByRole('button', { name: 'Upload' }));
  await waitForTimelineFile(page, fileName);
  return fileName;
}

export async function downloadFileFromTimeline(page, fileName, outputDirectory) {
  const downloadPattern = buildTimelineFilePattern(fileName);
  const buttonTarget = page.getByRole('button', { name: downloadPattern });
  const linkTarget = page.getByRole('link', { name: downloadPattern });
  await eventually(async () => {
    assert.ok(
      await isVisible(buttonTarget) || await isVisible(linkTarget),
      `expected downloadable attachment matching ${downloadPattern}`,
    );
  }, {
    attempts: 120,
    delayMs: 500,
  });
  const downloadTarget = await isVisible(buttonTarget) ? buttonTarget.last() : linkTarget.last();
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  await safeClick(downloadTarget);
  const download = await downloadPromise;
  const savedPath = path.join(outputDirectory, fileName);
  await fs.mkdir(path.dirname(savedPath), { recursive: true });
  await download.saveAs(savedPath);
  return savedPath;
}

export async function openAllSettings(page) {
  await safeClick(page.getByRole('button', { name: 'User menu' }));
  const menuItem = page.getByRole('menuitem', { name: 'All settings' });
  await safeClick(menuItem);
  await page.getByRole('dialog').waitFor({ timeout: 30_000 });
}

export async function closeSettingsDialog(page) {
  for (let index = 0; index < 6; index += 1) {
    const dialog = page.getByRole('dialog');
    const staticBackground = page.locator('#mx_Dialog_StaticContainer .mx_Dialog_background');
    if (await countVisible(dialog) === 0 && !await isVisible(staticBackground)) {
      return;
    }
    const closeButton = page.getByRole('button', { name: /Close dialog|Close/iu });
    if (await isVisible(closeButton)) {
      await safeClick(closeButton);
      await page.waitForTimeout(300);
      continue;
    }
    const cancelButton = page.getByRole('button', { name: 'Cancel' });
    if (await isVisible(cancelButton)) {
      await safeClick(cancelButton);
      await page.waitForTimeout(300);
      continue;
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  throw new Error('settings dialog remained visible after repeated close attempts');
}

export async function openEncryptionSettings(page) {
  await openAllSettings(page);
  await safeClick(page.getByRole('tab', { name: 'Encryption' }));
  await page.waitForTimeout(1_000);
}

function extractRecoveryKeyFromText(dialogText) {
  const match = dialogText.match(
    /Recovery key\s+([A-Za-z0-9 ]{20,}?)\s+(?:Do not share this with anyone!|Continue|Cancel)/su,
  );
  if (match) {
    return match[1].replace(/\s+/gu, ' ').trim();
  }
  const tokenMatches = dialogText.match(/[A-Za-z0-9]{4}(?:\s+[A-Za-z0-9]{4}){5,}/gu);
  if (tokenMatches?.length > 0) {
    return tokenMatches[0].replace(/\s+/gu, ' ').trim();
  }
  return null;
}

export async function setupRecovery(page) {
  await openEncryptionSettings(page);
  await safeClick(page.getByRole('button', { name: 'Set up recovery' }));
  const dialog = page.getByRole('dialog');
  await safeClick(dialog.getByRole('button', { name: 'Continue' }));
  await dialog.getByText('Save your recovery key somewhere safe').waitFor({ timeout: 30_000 });
  let recoveryKey = null;
  const keyPanelValue = dialog.locator('.mx_KeyPanel_key').first();
  if (await isVisible(keyPanelValue)) {
    recoveryKey = (await keyPanelValue.textContent())?.replace(/\s+/gu, ' ').trim() ?? null;
  }
  const recoveryKeyTestId = dialog.getByTestId('recoveryKey');
  if (recoveryKey == null && await isVisible(recoveryKeyTestId)) {
    recoveryKey = (await recoveryKeyTestId.textContent())?.trim() ?? null;
  }
  if (recoveryKey == null) {
    const dialogInnerText = await dialog.innerText().catch(() => null);
    if (dialogInnerText != null) {
      recoveryKey = extractRecoveryKeyFromText(dialogInnerText);
    }
  }
  if (recoveryKey == null) {
    recoveryKey = extractRecoveryKeyFromText(await dialog.textContent());
  }
  assert.ok(recoveryKey, 'expected recovery key to be visible');
  await safeClick(dialog.getByRole('button', { name: 'Continue' }));
  await page.waitForTimeout(1_000);
  await closeSettingsDialog(page);
  return recoveryKey;
}

export async function changeDisplayName(page, displayName) {
  await dismissForegroundPrompts(page);
  await openAllSettings(page);
  const displayNameInput = page.getByLabel('Display Name');
  await displayNameInput.fill(displayName);
  await displayNameInput.blur();
  const saveButton = page.getByRole('button', { name: 'Save' });
  const profileSaveResponse = page.waitForResponse((response) => (
    response.request().method() === 'PUT'
      && /\/_matrix\/client\/v3\/profile\/.+\/displayname$/u.test(response.url())
      && response.ok()
  ), {
    timeout: 10_000,
  }).then(() => true).catch(() => false);
  await safeClick(saveButton);
  if (!await profileSaveResponse) {
    await eventually(async () => {
      const bodyText = await page.textContent('body');
      assert.match(bodyText ?? '', /\bSaved\b/u);
    }, {
      attempts: 20,
      delayMs: 250,
    });
  }
  await page.waitForTimeout(1_500);
  await closeSettingsDialog(page);
}

export async function logoutViaUi(page) {
  await dismissForegroundPrompts(page);
  await safeClick(page.getByRole('button', { name: 'User menu' }));
  await safeClick(page.getByRole('menuitem', { name: 'Sign out' }));
  await eventually(async () => {
    if (/#\/(welcome|login)/u.test(page.url())) {
      return;
    }
    const signInButton = page.getByRole('button', { name: 'Sign in' });
    if (await isVisible(signInButton)) {
      return;
    }
    await dismissForegroundPrompts(page);
    const warningDismiss = page.locator('button:has-text("I don\'t want my encrypted messages")').first();
    if (await warningDismiss.isVisible().catch(() => false)) {
      await warningDismiss.click();
      throw new Error('logout confirmation dialog acknowledged; waiting for login screen');
    }
    const confirmSignOut = page.locator('#mx_Dialog_StaticContainer button:has-text("Sign out")').first();
    if (await confirmSignOut.isVisible().catch(() => false)) {
      await confirmSignOut.click();
      throw new Error('logout confirmed; waiting for login screen');
    }
    throw new Error('logout has not reached the login screen yet');
  }, {
    attempts: 120,
    delayMs: 500,
  });
}

export async function continueNewSessionPastIdentityPrompt(page) {
  return eventually(async () => {
    const state = await readVerificationStage(page);
    if (state.stage === 'confirm_identity') {
      await safeClick(page.getByRole('button', { name: 'Use another device' }));
      throw new Error('advanced past confirm identity prompt; waiting for verification flow');
    }

    if (
      state.stage === 'pending_existing_device_approval'
      || state.stage === 'choose_method'
      || state.stage === 'compare_emojis'
      || state.stage === 'waiting_other_device'
      || state.stage === 'device_verified'
    ) {
      await dismissForegroundPrompts(page, { preserveVerification: true });
      return true;
    }

    if (state.stage === 'app') {
      return false;
    }

    if (
      state.stage === 'unknown'
      && /Signing In|Sign in|Username|Password|Homeserver/iu.test(state.bodyText)
    ) {
      throw new Error(`waiting for login flow to stabilize, received ${describeVerificationState(state)}`);
    }

    throw new Error(`unexpected new-session verification state ${describeVerificationState(state)}`);
  }, {
    attempts: 120,
    delayMs: 500,
  });
}

export async function approveNewSessionWithExistingDevice(existingPage, newSessionPage) {
  await continueNewSessionPastIdentityPrompt(newSessionPage);
  await dismissForegroundPrompts(existingPage, { preserveVerification: true });
  await dismissForegroundPrompts(newSessionPage, { preserveVerification: true });

  await eventually(async () => {
    await dismissForegroundPrompts(existingPage, { preserveVerification: true });
    const state = await readVerificationStage(existingPage);
    assert.ok(
      [
        'existing_confirm_login',
        'existing_start_verification',
        'choose_method',
        'compare_emojis',
        'device_verified',
        'app',
      ].includes(state.stage),
      `expected existing session to be inside the verification flow, received ${describeVerificationState(state)}`,
    );
    if (state.stage === 'existing_confirm_login') {
      await safeClick(existingPage.getByRole('button', { name: 'Yes, it was me' }));
    }
  }, {
    attempts: 120,
    delayMs: 500,
  });

  await eventually(async () => {
    await dismissForegroundPrompts(existingPage, { preserveVerification: true });
    const state = await readVerificationStage(existingPage);
    assert.ok(
      [
        'existing_start_verification',
        'choose_method',
        'compare_emojis',
        'device_verified',
        'app',
      ].includes(state.stage),
      `expected existing session to offer or already complete Start Verification, received ${describeVerificationState(state)}`,
    );
    if (state.stage === 'existing_start_verification') {
      await safeClick(existingPage.getByRole('button', { name: /Start Verification/iu }));
    }
  }, {
    attempts: 120,
    delayMs: 500,
  });

  await eventually(async () => {
    await dismissForegroundPrompts(existingPage, { preserveVerification: true });
    await dismissForegroundPrompts(newSessionPage, { preserveVerification: true });
    const startClicked = (
      await startVerificationMethodIfVisible(existingPage)
      || await startVerificationMethodIfVisible(newSessionPage)
    );
    const existingState = await readVerificationStage(existingPage);
    const newSessionState = await readVerificationStage(newSessionPage);
    assert.ok(
      startClicked
        || existingState.stage === 'compare_emojis'
        || newSessionState.stage === 'compare_emojis',
      `expected verification method selection to advance, received existing=${describeVerificationState(existingState)} new=${describeVerificationState(newSessionState)}`,
    );
  }, {
    attempts: 120,
    delayMs: 500,
  });

  await eventually(async () => {
    await dismissForegroundPrompts(existingPage, { preserveVerification: true });
    await dismissForegroundPrompts(newSessionPage, { preserveVerification: true });
    const existingMatched = await confirmEmojiMatchIfVisible(existingPage);
    const newSessionMatched = await confirmEmojiMatchIfVisible(newSessionPage);
    const existingState = await readVerificationStage(existingPage);
    const newSessionState = await readVerificationStage(newSessionPage);
    assert.ok(
      existingMatched
        || newSessionMatched
        || existingState.stage === 'device_verified'
        || newSessionState.stage === 'device_verified',
      `expected emoji confirmation or verified state, received existing=${describeVerificationState(existingState)} new=${describeVerificationState(newSessionState)}`,
    );
  }, {
    attempts: 120,
    delayMs: 500,
  });

  await eventually(async () => {
    await dismissForegroundPrompts(existingPage, { preserveVerification: true });
    await dismissForegroundPrompts(newSessionPage, { preserveVerification: true });
    await confirmEmojiMatchIfVisible(existingPage);
    await confirmEmojiMatchIfVisible(newSessionPage);
    await acknowledgeDeviceVerifiedIfVisible(existingPage);
    await acknowledgeDeviceVerifiedIfVisible(newSessionPage);
    const existingState = await readVerificationStage(existingPage);
    const newSessionState = await readVerificationStage(newSessionPage);
    assert.ok(
      existingState.stage === 'device_verified' || existingState.stage === 'app',
      `expected existing session to finish verification, received ${describeVerificationState(existingState)}`,
    );
    assert.ok(
      newSessionState.stage === 'device_verified' || newSessionState.stage === 'app',
      `expected new session to finish verification, received ${describeVerificationState(newSessionState)}`,
    );
  }, {
    attempts: 120,
    delayMs: 500,
  });

  await dismissForegroundPrompts(existingPage, { preserveVerification: true });
  await dismissForegroundPrompts(newSessionPage, { preserveVerification: true });
  // Element applies trust state asynchronously after the final SAS confirmation.
  await Promise.all([
    existingPage.waitForTimeout(2_000),
    newSessionPage.waitForTimeout(2_000),
  ]);
}

async function startVerificationMethodIfVisible(page) {
  await dismissForegroundPrompts(page, { preserveVerification: true });
  const state = await readVerificationStage(page);
  if (state.stage !== 'choose_method') {
    return false;
  }
  await safeClick(page.getByRole('button', { name: 'Start' }));
  return true;
}

async function confirmEmojiMatchIfVisible(page) {
  await dismissForegroundPrompts(page, { preserveVerification: true });
  const state = await readVerificationStage(page);
  if (state.stage !== 'compare_emojis') {
    return false;
  }
  await safeClick(page.getByRole('button', { name: /They match/iu }));
  return true;
}

async function acknowledgeDeviceVerifiedIfVisible(page) {
  const state = await readVerificationStage(page);
  if (state.stage !== 'device_verified') {
    return false;
  }
  const gotIt = page.getByRole('button', { name: 'Got it' });
  if (await isVisible(gotIt)) {
    await safeClick(gotIt);
  }
  return true;
}

export async function waitForTimelineFile(page, fileName) {
  const filePattern = buildTimelineFilePattern(fileName);
  await eventually(async () => {
    const fileButton = page.getByRole('button', { name: filePattern });
    const fileLink = page.getByRole('link', { name: filePattern });
    const fileText = page.getByText(filePattern);
    assert.ok(
      await isVisible(fileButton) || await isVisible(fileLink) || await isVisible(fileText),
      `expected timeline file matching ${filePattern}`,
    );
  }, {
    attempts: 120,
    delayMs: 500,
  });
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

async function readVerificationStage(page) {
  const bodyText = normalizeText(await page.textContent('body').catch(() => ''));
  const confirmIdentity = page.getByRole('heading', { name: /Confirm your identity/iu });
  if (await isVisible(confirmIdentity)) {
    return {
      stage: 'confirm_identity',
      bodyText,
    };
  }

  const yesItWasMe = page.getByRole('button', { name: 'Yes, it was me' });
  if (/New login\. Was this you\?/iu.test(bodyText) && await isVisible(yesItWasMe)) {
    return {
      stage: 'existing_confirm_login',
      bodyText,
    };
  }

  const startVerification = page.getByRole('button', { name: /Start Verification/iu });
  if (/Verification requested/iu.test(bodyText) && await isVisible(startVerification)) {
    return {
      stage: 'existing_start_verification',
      bodyText,
    };
  }

  const compareEmojis = page.getByRole('button', { name: /They match/iu });
  if (/Compare emojis|Compare unique emoji/iu.test(bodyText) && await isVisible(compareEmojis)) {
    return {
      stage: 'compare_emojis',
      bodyText,
    };
  }

  const verificationStart = page.getByRole('button', { name: 'Start' });
  if (/Choose how to verify/iu.test(bodyText) && await isVisible(verificationStart)) {
    return {
      stage: 'choose_method',
      bodyText,
    };
  }

  if (/Waiting for you to verify on your other device/iu.test(bodyText)) {
    return {
      stage: 'waiting_other_device',
      bodyText,
    };
  }

  if (/Device verified/iu.test(bodyText)) {
    return {
      stage: 'device_verified',
      bodyText,
    };
  }

  if (/Verification Request|Start verification on the other device/iu.test(bodyText)) {
    return {
      stage: 'pending_existing_device_approval',
      bodyText,
    };
  }

  const userMenu = page.getByRole('button', { name: 'User menu' });
  if (await isVisible(userMenu)) {
    return {
      stage: 'app',
      bodyText,
    };
  }

  return {
    stage: 'unknown',
    bodyText,
  };
}

function describeVerificationState(state) {
  const preview = normalizeText(state?.bodyText).slice(0, 240);
  return `${state?.stage ?? 'unknown'} (${preview || 'no body text'})`;
}
