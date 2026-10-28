import { expect, test } from '@playwright/test';

const demoUser = {
  id: 42,
  name: 'Demo User',
  email: 'demo@example.com',
};

async function mockAuthenticatedSession(page) {
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('cms_token', token);
    localStorage.setItem('cms_session_user', JSON.stringify(user));
  }, { token: 'demo-token', user: demoUser });

  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: demoUser }),
    });
  });

  await page.route('**/api/auth/logout', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Logged out successfully.' }),
    });
  });

  await page.route('**/api/organizations**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [{ id: 5, name: 'Northwind', my_role: 'owner' }],
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: {} }),
    });
  });

  await page.route('**/api/projects**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [{ id: 10, name: 'Launch', organization_id: 5 }],
        }),
      });
      return;
    }

    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: { id: 10, name: 'Launch' } }),
    });
  });

  await page.route('**/api/organizations/5/members**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [demoUser],
      }),
    });
  });

  await page.route('**/api/projects/10/members**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [demoUser],
      }),
    });
  });

  await page.route('**/api/projects/*/statuses', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 1, key: 'todo', label: 'To do' }] }),
    });
  });

  await page.route('**/api/tasks**', async (route) => {
    const method = route.request().method();

    if (method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [{
            id: 1,
            title: 'Launch sprint',
            description: 'Coordinate the launch plan for the new release.',
            priority: 'high',
            status: 'todo',
            project_id: 10,
            project_name: 'Launch',
          }],
        }),
      });
      return;
    }

    if (method === 'POST') {
      const payload = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: 99,
            ...payload,
          },
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
  });

  await page.route('**/api/tasks/analyze**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          title: 'Ship release',
          description: 'Ship the release candidate with QA validation.',
          priority: 'high',
          status: 'todo',
        },
      }),
    });
  });
}

test('redirects unauthenticated users and allows login', async ({ page }) => {
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Unauthorized' }),
    });
  });

  await page.route('**/api/auth/login', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    expect(body.email).toBe('demo@example.com');
    expect(body.password).toBe('Passw0rd!');

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          token: 'demo-token',
          user: demoUser,
        },
      }),
    });
  });

  await page.route('**/api/tasks**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) });
  });

  await page.route('**/api/projects**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) });
  });

  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

  await page.goto('/tasks');
  await expect(page).toHaveURL(/\/login$/);

  await page.goto('/login');
  await page.getByLabel('Email').fill('demo@example.com');
  await page.locator('#login-password').fill('Passw0rd!');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByText('Welcome back')).toBeVisible();
  await expect.poll(async () => page.evaluate(() => localStorage.getItem('cms_token'))).toBe('demo-token');
});

test('logs out safely and blocks protected routes', async ({ page }) => {
  await mockAuthenticatedSession(page);
  await page.goto('/tasks');

  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
  await page.getByRole('button', { name: 'Log out' }).click();

  await expect(page).toHaveURL(/\/login$/);
  await expect.poll(async () => page.evaluate(() => localStorage.getItem('cms_token'))).toBeNull();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});

test('shows working end-chat controls in the Global AI drawer', async ({ page }) => {
  await mockAuthenticatedSession(page);
  await page.route('**/api/ai/global/chat/history', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { messages: [] } }),
    });
  });
  await page.route('**/api/ai/global/proposals**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { proposals: [] } }),
    });
  });

  await page.goto('/tasks');
  await page.getByRole('button', { name: 'Open AI Agent', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'DevFlow AI' })).toBeVisible();
  await page.getByRole('button', { name: 'Conversation actions' }).click();
  await page.getByRole('button', { name: 'End chat' }).click();

  await expect(page.getByRole('heading', { name: 'End chat session' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'End session' })).toBeEnabled();

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'End chat session' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close AI Agent' }).click();
  await page.getByRole('button', { name: 'Open AI Agent', exact: true }).click();
  await expect(page.getByRole('region', { name: 'DevFlow AI chat' })).toBeVisible();
});

test('keeps the desktop drawer below the header and within a stable width', async ({ page }) => {
  await mockAuthenticatedSession(page);
  await page.route('**/api/ai/global/chat', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { answer: 'The final answer remains readable above the composer.', sources: [] } }),
    });
  });
  await page.route('**/api/ai/global/chat/history', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { messages: [] } }) });
  });
  await page.route('**/api/ai/global/proposals**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { proposals: [] } }) });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
  const shell = await page.evaluate(() => ({
    themes: ['dark', 'light'].map((theme) => {
      document.documentElement.dataset.theme = theme;
      return {
        sidebar: getComputedStyle(document.querySelector('.sidebar')).backgroundColor,
        topbar: getComputedStyle(document.querySelector('.topbar')).backgroundColor,
      };
    }),
    topbarHeight: document.querySelector('.topbar').getBoundingClientRect().height,
  }));
  for (const theme of shell.themes) expect(theme.topbar).toBe(theme.sidebar);
  expect(shell.topbarHeight).toBeGreaterThanOrEqual(52);
  expect(shell.topbarHeight).toBeLessThanOrEqual(58);
  const mainWidthBeforeOpen = await page.locator('.main-content').evaluate((element) => element.getBoundingClientRect().width);

  await page.getByRole('button', { name: 'Open AI Agent', exact: true }).click();
  const drawer = page.getByRole('region', { name: 'DevFlow AI chat' });
  await expect(drawer).toBeVisible();
  await expect(page.getByRole('heading', { name: 'DevFlow AI' })).toBeVisible();
  await expect(drawer.locator('.ai-input-row')).toBeVisible();
  const composer = drawer.getByRole('textbox', { name: 'Message DevFlow AI' });
  await expect(composer).toBeVisible();
  await composer.fill('How is the workspace?');
  await composer.press('Shift+Enter');
  await expect(composer).toHaveValue('How is the workspace?\n');
  await composer.press('Enter');
  await expect(drawer.getByText('The final answer remains readable above the composer.')).toBeVisible();
  await page.locator('.ai-global-panel').evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  const layout = await page.evaluate(() => {
    const panel = document.querySelector('.ai-global-panel');
    const panelRect = panel.getBoundingClientRect();
    const topbar = document.querySelector('.topbar').getBoundingClientRect();
    return {
      width: panel.offsetWidth,
      top: panelRect.top,
      topbarBottom: topbar.bottom,
      right: panelRect.right,
      viewportWidth: window.innerWidth,
      mainWidth: document.querySelector('.main-content').getBoundingClientRect().width,
      mainRight: document.querySelector('.main-content').getBoundingClientRect().right,
      panelLeft: panelRect.left,
      documentWidth: document.documentElement.scrollWidth,
      bodyOverflowY: getComputedStyle(document.querySelector('.ai-global-body')).overflowY,
      bodyBottom: document.querySelector('.ai-global-body').getBoundingClientRect().bottom,
      composerTop: document.querySelector('.ai-input-row').getBoundingClientRect().top,
      composerBottom: document.querySelector('.ai-input-row').getBoundingClientRect().bottom,
      panelBottom: panelRect.bottom,
    };
  });
  expect(layout.width).toBeGreaterThanOrEqual(420);
  expect(layout.width).toBeLessThanOrEqual(520);
  expect(layout.top).toBeGreaterThanOrEqual(layout.topbarBottom);
  expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.mainWidth).toBeLessThan(mainWidthBeforeOpen);
  expect(mainWidthBeforeOpen - layout.mainWidth).toBeGreaterThanOrEqual(500);
  expect(layout.panelLeft).toBeGreaterThanOrEqual(layout.mainRight);
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.bodyOverflowY).toBe('auto');
  expect(layout.bodyBottom).toBeLessThanOrEqual(layout.composerTop);
  expect(layout.panelBottom - layout.composerBottom).toBeLessThanOrEqual(20);
});

test('creates a quick task from the navbar after selecting an authorized project', async ({ page }) => {
  await mockAuthenticatedSession(page);
  let createdPayload;
  let taskSaved = false;
  await page.route('**/api/tasks', async (route) => {
    if (route.request().method() === 'POST') {
      createdPayload = JSON.parse(route.request().postData() || '{}');
      taskSaved = true;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ data: { id: 100, ...createdPayload } }),
      });
      return;
    }
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            { id: 1, title: 'Launch sprint', project_id: 10, project_name: 'Launch' },
            ...(taskSaved ? [{ id: 100, ...createdPayload }] : []),
          ],
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto('/tasks');
  await page.getByRole('button', { name: 'Create Task', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Create task' })).toBeVisible();
  await page.getByRole('button', { name: 'Organization' }).click();
  await page.getByRole('option', { name: 'Northwind' }).click();
  await page.getByRole('button', { name: 'Project' }).click();
  await page.getByRole('option', { name: 'Launch' }).click();
  await page.getByLabel('Task title').fill('Prepare deploy');
  await expect(page.getByRole('button', { name: 'Create task', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Create task', exact: true }).click();

  await expect(page.getByText('"Prepare deploy" was added to the selected project.')).toBeVisible();
  expect(createdPayload).toMatchObject({
    title: 'Prepare deploy',
    organizationId: 5,
    projectId: 10,
  });
  await expect(page.getByRole('heading', { name: 'Prepare deploy' })).toBeVisible();
});

test('opens one responsive Task Agent workspace with the selected authenticated task context', async ({ page }) => {
  await mockAuthenticatedSession(page);
  const task = {
    id: 1,
    title: 'Launch sprint',
    description: 'Coordinate the launch.',
    project_id: 10,
    project_name: 'Launch',
    organization_id: 5,
    organization_name: 'Northwind',
  };
  let agentRequest;
  let historyRequests = 0;
  let endChatRequests = 0;

  await page.route('**/api/tasks/1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: task }),
    });
  });
  await page.route('**/api/ai/task/1/chat/history', async (route) => {
    historyRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { messages: [], sessionStatus: 'ACTIVE' } }),
    });
    await page.route('**/api/ai/task/1/chat/end', async (route) => {
      endChatRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: {} }),
      });
    });
  });
  await page.route('**/api/ai/task/1/agent', async (route) => {
    agentRequest = {
      headers: await route.request().allHeaders(),
      body: JSON.parse(route.request().postData() || '{}'),
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { answer: 'Task details checked.' } }),
    });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/tasks');
  await page.getByRole('button', { name: 'Task Agent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Task Agent' });
  await expect(dialog.getByLabel('Choose a task')).toBeVisible();
  await page.getByLabel('Choose a task').selectOption('1');
  await expect(dialog.getByRole('heading', { name: 'Work with this task' })).toBeVisible();
  await expect(dialog.getByText('Project #10')).toBeVisible();
  await expect(dialog.getByText('Org #5')).toBeVisible();
  const initialHistoryRequests = historyRequests;

  const agentInput = dialog.getByRole('textbox', { name: 'Ask the task agent' });
  await agentInput.fill('Show this task status');
  await dialog.getByRole('button', { name: 'Send' }).first().click();
  await expect(dialog.getByText('Task details checked.')).toBeVisible();
  expect(agentRequest.body).toMatchObject({
    message: 'Show this task status',
    confirmationToken: null,
    confirmationAction: null,
  });
  expect(agentRequest.headers.authorization).toBe('Bearer demo-token');

  const desktopBounds = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
  });
  expect(desktopBounds.left).toBeGreaterThanOrEqual(0);
  expect(desktopBounds.right).toBeLessThanOrEqual(1440);
  expect(desktopBounds.top).toBeGreaterThanOrEqual(0);
  expect(desktopBounds.bottom).toBeLessThanOrEqual(900);

  await page.getByRole('button', { name: 'Close Task Agent' }).click();
  expect(historyRequests).toBe(initialHistoryRequests);
  expect(endChatRequests).toBe(0);
  await page.getByRole('button', { name: 'Task Agent', exact: true }).click();
  await page.getByLabel('Choose a task').selectOption('1');
  await expect(page.getByRole('heading', { name: 'Work with this task' })).toBeVisible();
  await expect.poll(() => historyRequests).toBeGreaterThan(initialHistoryRequests);
  await expect(page.getByRole('button', { name: 'End Chat' })).toHaveCount(1);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileBounds = await page.getByRole('dialog', { name: 'Task Agent' }).evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
  });
  expect(mobileBounds.left).toBeGreaterThanOrEqual(0);
  expect(mobileBounds.right).toBeLessThanOrEqual(390);
  expect(mobileBounds.top).toBeGreaterThanOrEqual(0);
  expect(mobileBounds.bottom).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('uses a near-full-screen mobile drawer without horizontal overflow', async ({ page }) => {
  await mockAuthenticatedSession(page);
  await page.route('**/api/ai/global/chat/history', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { messages: [] } }) });
  });
  await page.route('**/api/ai/global/proposals**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { proposals: [] } }) });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/tasks');
  await page.getByRole('button', { name: 'Open AI Agent', exact: true }).click();
  const drawer = page.getByRole('region', { name: 'DevFlow AI chat' });
  await expect(drawer).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close AI Agent' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Task' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open AI Agent', exact: true })).toBeVisible();

  const layout = await page.evaluate(() => {
    const panel = document.querySelector('.ai-global-panel');
    const panelRect = panel.getBoundingClientRect();
    const topbar = document.querySelector('.topbar').getBoundingClientRect();
    return {
      width: panel.offsetWidth,
      height: panel.offsetHeight,
      top: panelRect.top,
      topbarBottom: topbar.bottom,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(layout.width).toBeGreaterThanOrEqual(360);
  expect(layout.width).toBeLessThanOrEqual(390);
  expect(layout.height).toBeGreaterThan(600);
  expect(layout.top).toBeGreaterThanOrEqual(layout.topbarBottom);
  expect(layout.documentWidth).toBeLessThanOrEqual(390);
});

test('renders the redesigned workspace shell across core pages and mobile task detail', async ({ page }) => {
  await mockAuthenticatedSession(page);
  const organization = {
    id: 5,
    name: 'Northwind',
    description: 'Product and engineering workspace.',
    my_role: 'owner',
    member_count: 3,
    admin_count: 1,
  };
  const project = {
    id: 10,
    name: 'Launch',
    description: 'Coordinate the next product release.',
    organization_id: 5,
    organization_name: 'Northwind',
    my_project_role: 'project_admin',
    my_org_role: 'owner',
    status: 'active',
    member_count: 2,
  };
  const task = {
    id: 1,
    title: 'Prepare launch plan',
    description: 'Coordinate release milestones, owners, and readiness reviews.',
    project_id: 10,
    project_name: 'Launch',
    organization_id: 5,
    organization_name: 'Northwind',
    creator_name: 'Demo User',
    assignee_name: 'Demo User',
    assignee_id: 42,
    status: 'in_progress',
    status_label: 'In progress',
    priority: 'high',
    due_date: '2026-11-02',
    role_tag_label: 'Product',
  };
  const json = (data) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data }),
  });

  await page.route('**/api/organizations/5', (route) => route.fulfill(json(organization)));
  await page.route('**/api/organizations/5/invitations', (route) => route.fulfill(json([])));
  await page.route('**/api/projects/10', (route) => route.fulfill(json(project)));
  await page.route('**/api/projects/10/members', (route) => route.fulfill(json([demoUser])));
  await page.route('**/api/projects/10/statuses', (route) => route.fulfill(json([
    { id: 1, key: 'todo', label: 'To do', color: '#858a96' },
    { id: 2, key: 'in_progress', label: 'In progress', color: '#a394ff' },
    { id: 3, key: 'done', label: 'Done', color: '#63c995' },
  ])));
  await page.route('**/api/projects/10/role-tags', (route) => route.fulfill(json([{ id: 2, label: 'Product' }])));
  await page.route('**/api/tasks/1', (route) => route.fulfill(json(task)));
  await page.route('**/api/comments/task/1', (route) => route.fulfill(json([])));
  await page.route('**/api/ai/global/**', (route) => route.fulfill(json({ messages: [], proposals: [] })));
  await page.route('**/api/ai/task/**', (route) => route.fulfill(json({ messages: [], sessionStatus: 'ACTIVE' })));

  await page.setViewportSize({ width: 1440, height: 900 });
  const pages = [
    ['/overview', 'Welcome back'],
    ['/tasks', 'Tasks'],
    ['/tasks/1', 'Prepare launch plan'],
    ['/projects', 'Projects'],
    ['/projects/10', 'Launch'],
    ['/organizations', 'Organizations'],
    ['/organizations/5', 'Northwind'],
  ];

  for (const [path, heading] of pages) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, exact: false }).first()).toBeVisible();
    const shell = await page.evaluate(() => ({
      hasSidebar: Boolean(document.querySelector('.sidebar')),
      hasTopbar: Boolean(document.querySelector('.topbar')),
      hasFloatingLauncher: Boolean(document.querySelector('.gai-launcher')),
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    expect(shell.hasSidebar).toBe(true);
    expect(shell.hasTopbar).toBe(true);
    expect(shell.hasFloatingLauncher).toBe(false);
    expect(shell.documentWidth).toBeLessThanOrEqual(shell.viewportWidth);
  }

  await page.goto('/overview');
  await page.getByRole('button', { name: 'Search workspace' }).click();
  await expect(page.getByPlaceholder('Search or jump to…')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByPlaceholder('Search or jump to…')).toHaveCount(0);

  await page.getByRole('button', { name: 'Open AI Agent', exact: true }).click();
  await expect(page.getByRole('region', { name: 'DevFlow AI chat' })).toBeVisible();
  await page.getByRole('button', { name: 'Close AI Agent' }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/tasks/1');
  await expect(page.getByRole('heading', { name: 'Prepare launch plan' })).toBeVisible();
  const mobileDetail = await page.evaluate(() => ({
    columns: getComputedStyle(document.querySelector('.detail-grid')).gridTemplateColumns,
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(mobileDetail.columns.trim().split(/\s+/)).toHaveLength(1);
  expect(mobileDetail.documentWidth).toBeLessThanOrEqual(mobileDetail.viewportWidth);

  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await expect(page.locator('.sidebar')).toHaveClass(/open/);
  await page.getByRole('button', { name: 'Close navigation menu' }).click();
  await expect(page.locator('.sidebar')).not.toHaveClass(/open/);

  await page.getByRole('button', { name: 'Open Task Agent' }).click();
  const dialog = page.getByRole('dialog', { name: 'Task Agent' });
  await expect(dialog).toBeVisible();
  const dialogBounds = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
  });
  expect(dialogBounds.left).toBeGreaterThanOrEqual(0);
  expect(dialogBounds.right).toBeLessThanOrEqual(390);
  expect(dialogBounds.top).toBeGreaterThanOrEqual(0);
  expect(dialogBounds.bottom).toBeLessThanOrEqual(844);
});

test('runs the main task workflow through the AI task modal', async ({ page }) => {
  await mockAuthenticatedSession(page);

  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();

  await page.getByRole('button', { name: /Create with AI/i }).first().click();
  await page.getByRole('button', { name: 'Organization' }).click();
  await page.getByRole('option', { name: 'Northwind' }).click();
  await page.getByRole('button', { name: 'Project' }).click();
  await page.getByRole('option', { name: 'Launch' }).click();

  await page.locator('textarea').fill('Prepare the release candidate for launch.');
  await page.getByRole('button', { name: /Analyze with AI/i }).click();

  await expect(page.getByText('AI reviewed your request and prepared a task.')).toBeVisible();
  await page.getByRole('button', { name: /Create task/i }).last().click();

  await expect(page.getByText('Task created successfully.')).toBeVisible();
  await expect(page).toHaveURL(/\/tasks$/);
});
