// API 封装：地址可配置（localStorage）、摄影师 token 管理、统一响应处理
(function (global) {
  "use strict";

  const TOKEN_KEY = "admin_token";

  function getBase() {
    let b = localStorage.getItem("api_base");
    if (!b) b = "/api";
    // 去除末尾斜杠
    return b.replace(/\/+$/, "");
  }
  function setBase(b) {
    localStorage.setItem("api_base", (b || "").trim());
  }

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }

  // 把相对 API 路径（如 /share/xxx/photos/1/preview）解析为完整 URL
  function url(path) {
    if (!path) return "";
    if (/^https?:\/\//i.test(path)) return path;
    const base = getBase();
    // path 形如 /share/... ，需拼到 API base 之后
    return base + path;
  }

  async function request(path, opts) {
    opts = opts || {};
    const full = getBase() + path;
    const headers = Object.assign({}, opts.headers || {});
    const token = getToken();
    if (token) headers["Authorization"] = "Bearer " + token;

    let body = opts.body;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    }

    let res;
    try {
      res = await fetch(full, {
        method: opts.method || "GET",
        headers: headers,
        body: body,
        signal: opts.signal,
      });
    } catch (e) {
      throw { status: 0, msg: "network" };
    }

    let data = null;
    const ct = res.headers.get("content-type") || "";
    if (ct.indexOf("json") !== -1) {
      data = await res.json();
    } else {
      // 非_JSON（如文件流）直接返回响应
      return res;
    }

    if (!res.ok) {
      throw { status: res.status, msg: (data && (data.detail || data.msg)) || ("HTTP " + res.status) };
    }
    if (data && data.code !== 0) {
      throw { status: res.status, code: data.code, msg: data.msg || "error" };
    }
    return data ? data.data : null;
  }

  const API = {
    getBase: getBase,
    setBase: setBase,
    url: url,
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    request: request,

    // 鉴权
    login: function (u, p) {
      return request("/auth/login", { method: "POST", json: { username: u, password: p } });
    },
    me: function () { return request("/auth/me"); },

    // 活动
    listEvents: function () { return request("/events"); },
    createEvent: function (name) {
      return request("/events", { method: "POST", json: { event_name: name } });
    },
    getEvent: function (id) { return request("/events/" + encodeURIComponent(id)); },
    regenShare: function (id) {
      return request("/events/" + encodeURIComponent(id) + "/share", { method: "POST" });
    },

    // 上传
    uploadPhotos: function (eventId, files, tag, tagEn) {
      const fd = new FormData();
      for (let i = 0; i < files.length; i++) fd.append("files", files[i]);
      if (tag) fd.append("tag", tag);
      if (tagEn) fd.append("tag_en", tagEn);
      return request("/events/" + encodeURIComponent(eventId) + "/upload", { method: "POST", body: fd });
    },
    uploadRaf: function (eventId, files) {
      const fd = new FormData();
      for (let i = 0; i < files.length; i++) fd.append("files", files[i]);
      return request("/events/" + encodeURIComponent(eventId) + "/upload-raf", { method: "POST", body: fd });
    },

    // 公开访问
    shareInfo: function (token) { return request("/share/" + encodeURIComponent(token)); },
    sharePhotos: function (token, opts) {
      opts = opts || {};
      const q = new URLSearchParams();
      if (opts.tag) q.set("tag", opts.tag);
      q.set("page", opts.page || 1);
      q.set("size", opts.size || 30);
      return request("/share/" + encodeURIComponent(token) + "/photos?" + q.toString());
    },
  };

  global.API = API;
})(window);
