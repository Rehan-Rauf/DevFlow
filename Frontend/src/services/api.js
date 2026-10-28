// ======================================================
// API BASE URL
// ======================================================

// Get API URL from Vite environment variable.
//
// Example .env:
// VITE_API_URL=http://localhost:5001/api
//
// If VITE_API_URL is not available,
// use the default backend URL.

const API_URL =
  import.meta.env.VITE_API_URL ||
  "http://localhost:5001/api";


// ======================================================
// COMMON REQUEST FUNCTION
// ======================================================

// This function is used for ALL API requests.
//
// Instead of writing fetch() again and again,
// we create one common request() function.
//
// path    → API endpoint
// options → request method, body, headers, etc.

async function request(path, options = {}) {

  // Get JWT token from browser localStorage.
  //
  // Token was saved during login/signup.

  const token = localStorage.getItem("cms_token");


  // Send request to backend.

  const response = await fetch(`${API_URL}${path}`, {

    // Keep any options passed to fetch.
    ...options,

    // Request headers.
    headers: {

      // Tell backend that we are sending JSON data.
      "Content-Type": "application/json",

      // If a token exists,
      // send it in Authorization header.

      ...(token
        ? { Authorization: `Bearer ${token}` }
        : {}),

      // If caller provides its own headers,
      // add/override them here.

      ...(options.headers || {})
    }
  });

  if (response.status === 401 && token) {
    localStorage.removeItem("cms_token");
    window.dispatchEvent(new Event("auth-expired"));
  }

  // Convert backend response into JSON.
  //
  // If response doesn't contain JSON,
  // use an empty object instead.

  const body =
    await response.json().catch(() => ({}));


  // ======================================================
  // ERROR HANDLING
  // ======================================================

  if (!response.ok) {

    const error = new Error(
      body.message || "Request failed."
    );

    error.status = response.status;

    throw error;
  }


  // If request was successful,
  // return backend response.

  return body;
}


// ======================================================
// API FUNCTIONS
// ======================================================

export const api = {


  // ======================================================
  // AUTHENTICATION
  // ======================================================

  // Signup new user.
  //
  // POST /auth/signup

  signup: (data) =>
    request("/auth/signup", {
      method: "POST",
      body: JSON.stringify(data)
    }),


  // Login existing user.
  //
  // POST /auth/login

  login: (data) =>
    request("/auth/login", {
      method: "POST",
      body: JSON.stringify(data)
    }),

  requestPasswordReset: (data) =>
    request("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  resetPassword: (data) =>
    request("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  logout: () =>
    request("/auth/logout", {
      method: "POST",
    }),


  // Get currently logged-in user.
  //
  // GET /auth/me

  me: () =>
    request("/auth/me"),

  updateProfile: (data) =>
    request("/auth/me", {
      method: "PUT",
      body: JSON.stringify(data),
    }),



  // ======================================================
  // ORGANIZATIONS
  // ======================================================

  // Get organizations of logged-in user.
  //
  // GET /organizations

  organizations: () =>
    request("/organizations"),


  // Create a new organization.
  //
  // POST /organizations

  createOrganization: (data) =>
    request("/organizations", {
      method: "POST",
      body: JSON.stringify(data)
    }),


  // Get one organization by ID.
  //
  // GET /organizations/5

  getOrganization: (id) =>
    request(`/organizations/${id}`),


  // Update organization.
  //
  // PUT /organizations/5

  updateOrganization: (id, data) =>
    request(`/organizations/${id}`, {
      method: "PUT",
      body: JSON.stringify(data)
    }),


  // Delete organization.
  //
  // DELETE /organizations/5

  deleteOrganization: (id) =>
    request(
      `/organizations/${id}`,
      {
        method: "DELETE"
      }
    ),


  // Get members of an organization.
  //
  // GET /organizations/5/members

  members: (id) =>
    request(`/organizations/${id}/members`),


  // Add a member to an organization.
  //
  // POST /organizations/5/members

  addMember: (id, data) =>
    request(`/organizations/${id}/members`, {
      method: "POST",
      body: JSON.stringify(data)
    }),


  // Change an organization member's role.
  //
  // PUT /organizations/5/members/10

  updateMember: (id, userId, data) =>
    request(
      `/organizations/${id}/members/${userId}`,
      {
        method: "PUT",
        body: JSON.stringify(data)
      }
    ),


  // Remove a member from organization.
  //
  // DELETE /organizations/5/members/10

  removeMember: (id, userId) =>
    request(
      `/organizations/${id}/members/${userId}`,
      {
        method: "DELETE"
      }
    ),

  getInvitation: (token) =>
    request(`/invitations/${encodeURIComponent(token)}`),

  acceptInvitation: (token) =>
    request(`/invitations/${encodeURIComponent(token)}/accept`, {
      method: "POST",
    }),

  acceptInvitationAndCreateAccount: (token, data) =>
    request(`/invitations/${encodeURIComponent(token)}/accept-and-create-account`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  invitations: (id) =>
    request(`/organizations/${id}/invitations`),

  revokeInvitation: (id, invitationId) =>
    request(`/organizations/${id}/invitations/${invitationId}`, {
      method: "DELETE",
    }),



  // ======================================================
  // PROJECTS
  // ======================================================

  // Get projects.
  //
  // Without organizationId:
  // GET /projects
  //
  // → Get projects from organizations
  //   where the logged-in user is a member.
  //
  // With organizationId:
  // GET /projects?organizationId=5
  //
  // → Get projects from organization 5.

  projects: (organizationId = null) =>
    request(
      organizationId
        ? `/projects?organizationId=${organizationId}`
        : "/projects"
    ),


  // ======================================================
  // GET ONE PROJECT
  // ======================================================

  // Get one project by ID.
  //
  // GET /projects/10
  //
  // Used by ProjectDetail.jsx.

  getProject: (id) =>
    request(`/projects/${id}`),


  // Create a new project.
  //
  // POST /projects

  createProject: (data) =>
    request("/projects", {
      method: "POST",
      body: JSON.stringify(data)
    }),


  // Update a project.
  //
  // PUT /projects/10

  updateProject: (id, data) =>
    request(`/projects/${id}`, {
      method: "PUT",
      body: JSON.stringify(data)
    }),


  // Delete a project.
  //
  // DELETE /projects/10

  deleteProject: (id) =>
    request(
      `/projects/${id}`,
      {
        method: "DELETE"
      }
    ),


  // Get members of a project.
  //
  // GET /projects/10/members

  projectMembers: (id) =>
    request(`/projects/${id}/members`),


  // Add a member to a project.
  //
  // POST /projects/10/members

  addProjectMember: (id, data) =>
    request(`/projects/${id}/members`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  projectStatuses: (id) => request(`/projects/${id}/statuses`),
  createProjectStatus: (id, data) => request(`/projects/${id}/statuses`, { method: "POST", body: JSON.stringify(data) }),
  updateProjectStatus: (id, statusId, data) => request(`/projects/${id}/statuses/${statusId}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteProjectStatus: (id, statusId) => request(`/projects/${id}/statuses/${statusId}`, { method: "DELETE" }),
  reorderProjectStatuses: (id, statusIds) => request(`/projects/${id}/statuses/reorder`, { method: "PUT", body: JSON.stringify({ statusIds }) }),

  projectRoleTags: (id) => request(`/projects/${id}/role-tags`),
  createProjectRoleTag: (id, data) => request(`/projects/${id}/role-tags`, { method: "POST", body: JSON.stringify(data) }),
  updateProjectRoleTag: (id, roleTagId, data) => request(`/projects/${id}/role-tags/${roleTagId}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteProjectRoleTag: (id, roleTagId) => request(`/projects/${id}/role-tags/${roleTagId}`, { method: "DELETE" }),


  // Remove a member from project.
  //
  // DELETE /projects/10/members/20

  removeProjectMember: (id, userId) =>
    request(
      `/projects/${id}/members/${userId}`,
      {
        method: "DELETE"
      }
    ),



  // ======================================================
  // TASKS
  // ======================================================

  // ======================================================
  // GET TASKS FOR A PROJECT
  // ======================================================

  // GET /tasks?projectId=4
  //
  // Used on ProjectDetail.jsx.

  tasks: (projectId) =>
    request(`/tasks?projectId=${projectId}`),


  // ======================================================
  // GET MY TASKS
  // ======================================================

  // GET /tasks
  //
  // Used by TasksPage.jsx.
  //
  // The backend should return tasks available
  // to the currently logged-in user.

  getMyTasks: () =>
    request("/tasks"),


  // ======================================================
  // GET ONE TASK
  // ======================================================

  // GET /tasks/9
  //
  // Used by TaskDetail.jsx.

  getTask: (id) =>
    request(`/tasks/${id}`),


  // ======================================================
  // CREATE TASK
  // ======================================================

  // POST /tasks

  createTask: (data) =>
    request("/tasks", {
      method: "POST",
      body: JSON.stringify(data),
    }),


  // ======================================================
  // UPDATE TASK
  // ======================================================

  // PUT /tasks/9

  updateTask: (id, data) =>
    request(`/tasks/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),


  // ======================================================
  // AI TASK ANALYSIS
  // ======================================================

  // POST /tasks/analyze
  //
  // This sends the user's natural-language task request
  // to the backend AI validation endpoint.

  analyzeTask: async (data) => {
    return request("/tasks/analyze", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },


  // ======================================================
  // DELETE TASK
  // ======================================================

  // DELETE /tasks/9

  deleteTask: (id) =>
    request(`/tasks/${id}`, {
      method: "DELETE",
    }),


  // ======================================================
  // COMMENTS
  // ======================================================

  comments: (taskId) =>
    request(`/comments/task/${taskId}`),

  addComment: (taskId, data) =>
    request(`/comments/task/${taskId}`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  deleteComment: (id) =>
    request(`/comments/${id}`, {
      method: "DELETE",
    }),


  // ======================================================
  // KNOWLEDGE SEARCH
  // ======================================================

  // GET /knowledge/search?q=...&organizationId=...&projectId=...

  searchKnowledge: ({
    query,
    organizationId,
    projectId = null,
    limit = 8
  }) => {

    const params = new URLSearchParams();

    params.append("q", query);
    params.append("organizationId", organizationId);

    if (projectId) {
      params.append("projectId", projectId);
    }

    if (limit) {
      params.append("limit", limit);
    }

    return request(`/knowledge/search?${params.toString()}`);
  },


  // ======================================================
  // TASK AI CHAT
  // ======================================================

  // POST /ai/task/:taskId/chat

  taskChat: (taskId, message) =>
    request(`/ai/task/${taskId}/chat`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),

  // The task agent receives its task/project scope from the server. A
  // confirmation token is only supplied after the agent requests deletion.
  taskAgent: (taskId, message, confirmationToken = null, confirmationAction = null) =>
    request(`/ai/task/${taskId}/agent`, {
      method: "POST",
      body: JSON.stringify({ message, confirmationToken, confirmationAction }),
    }),


  // GET /ai/task/:taskId/chat/history

  taskChatHistory: (taskId) =>
    request(`/ai/task/${taskId}/chat/history`),


  // ======================================================
  // GLOBAL AI CHAT
  // ======================================================

  // POST /ai/global/chat

  globalChat: (message, context = null, requestId) =>
    request(`/ai/global/chat`, {
      method: "POST",
      body: JSON.stringify({ message, context, requestId }),
    }),


  // GET /ai/global/chat/history

  globalChatHistory: () =>
    request(`/ai/global/chat/history`),

  globalActionProposals: (sessionId = null) => {
    const params = new URLSearchParams();
    if (sessionId) params.set("sessionId", sessionId);
    const query = params.toString();
    return request(`/ai/global/proposals${query ? `?${query}` : ""}`);
  },

  approveGlobalAction: (proposalId) =>
    request(`/ai/global/proposals/${proposalId}/approve`, { method: "POST" }),

  cancelGlobalAction: (proposalId) =>
    request(`/ai/global/proposals/${proposalId}/cancel`, { method: "POST" }),


  // ======================================================
  // END CHAT SESSION
  // ======================================================

  // End active Task AI session.
  //
  // POST /ai/task/:taskId/chat/end

  taskChatEnd: (taskId) =>
    request(`/ai/task/${taskId}/chat/end`, {
      method: "POST",
    }),


  // End active Global AI session.
  //
  // POST /ai/global/chat/end

  globalChatEnd: () =>
    request(`/ai/global/chat/end`, {
      method: "POST",
    }),

  closeAllChats: () =>
    request(`/ai/chats/end-all`, {
      method: "POST",
    }),

  memories: (filters = {}) => {
    const params = new URLSearchParams(
      Object.entries(filters).filter(([, value]) => value !== undefined && value !== null && value !== ""),
    );
    return request(`/ai/memories${params.toString() ? `?${params}` : ""}`);
  },

  createMemory: (data) =>
    request("/ai/memories", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateMemory: (id, data) =>
    request(`/ai/memories/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  deleteMemory: (id) =>
    request(`/ai/memories/${id}`, { method: "DELETE" }),

  clearMemories: () =>
    request("/ai/memories", { method: "DELETE" }),

  searchMemories: (query, scope = {}) =>
    request(`/ai/memories/search?${new URLSearchParams({ query, ...scope })}`),

// ======================================================
// RECENT AI CHATS
// ======================================================

// GET /ai/chats/recent
//
// Returns Task AI and Global AI sessions
// for the logged-in user.

recentChats: () =>
  request(`/ai/chats/recent`),

deleteChatSession: (sessionId) =>
  request(`/ai/chats/${sessionId}`, { method: "DELETE" }),

// GET one saved AI chat session history.
chatSessionHistory: (sessionId) =>
  request(`/ai/chats/${sessionId}/history`),

};


// ======================================================
// NAMED EXPORT
// ======================================================

// Kept as a named export too,
// since components/KnowledgeSearch.jsx
// already imports { searchKnowledge } directly.

export const searchKnowledge = api.searchKnowledge;
