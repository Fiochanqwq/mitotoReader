export function libraryView(host, open, message) {
  const $ = (id) => document.getElementById(id);
  let entries = [],
    visible = 48;
  function draw() {
    const query = $("library-query").value.trim().toLocaleLowerCase();
    const filter = $("library-filter").value;
    const sort = $("library-sort").value;
    const list = entries.filter(
      (x) =>
        (!filter || x.kind === filter || (filter === "image" && /png|jpe?g/.test(x.kind))) &&
        `${x.title || ""} ${x.name} ${x.author || ""}`.toLocaleLowerCase().includes(query),
    );
    list.sort(
      sort === "title"
        ? (a, b) => (a.title || a.name).localeCompare(b.title || b.name, "zh-CN")
        : sort === "progress"
          ? (a, b) => b.progress - a.progress
          : (a, b) => (b.opened || b.added || 0) - (a.opened || a.added || 0),
    );
    $("library-count").textContent = `${list.length} 本 / 共 ${entries.length} 本`;
    $("recent").replaceChildren();
    for (const entry of list.slice(0, visible)) {
      const card = document.createElement("article");
      card.className = "book-card";
      const button = document.createElement("button");
      button.className = "book-open";
      button.title = entry.name;
      button.onclick = () => open(entry.id);
      const cover = document.createElement("div");
      cover.className = "book-cover";
      if (entry.cover) {
        const image = new Image();
        image.src = entry.cover;
        image.alt = "";
        image.loading = "lazy";
        cover.append(image);
      } else {
        const label = document.createElement("span");
        label.textContent = entry.kind.toUpperCase();
        cover.append(label);
      }
      const info = document.createElement("div");
      info.className = "book-info";
      const title = document.createElement("strong");
      title.textContent = entry.title || entry.name;
      const author = document.createElement("span");
      author.className = "muted small";
      author.textContent = entry.author || entry.kind.toUpperCase();
      const progress = document.createElement("progress");
      progress.max = 1;
      progress.value = entry.progress;
      progress.setAttribute("aria-label", "阅读进度");
      const status = document.createElement("span");
      status.className = "small muted";
      status.textContent = entry.missing
        ? "文件已移动，请重新定位"
        : entry.opened
          ? `已读 ${Math.round(entry.progress * 100)}%`
          : "尚未阅读";
      info.append(title, author, progress, status);
      button.append(cover, info);
      const actions = document.createElement("div");
      actions.className = "book-actions";
      const relink = document.createElement("button");
      relink.textContent = "重新定位";
      relink.className = "quiet";
      relink.onclick = async () => {
        try {
          await host.libraryRelink(entry.id);
          await refresh();
        } catch (e) {
          message(e.message);
        }
      };
      const remove = document.createElement("button");
      remove.textContent = "移出书库";
      remove.className = "quiet";
      remove.title = "只移除记录，不删除原文件；重新添加可恢复阅读位置与书签";
      remove.onclick = async () => {
        try {
          await host.libraryRemove(entry.id);
          await refresh();
          message("已移出书库，原文件和阅读位置保留。");
        } catch (e) {
          message(e.message);
        }
      };
      actions.append(relink, remove);
      card.append(button, actions);
      $("recent").append(card);
    }
    if (!list.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = entries.length
        ? "没有匹配的图书，试试其他关键词或格式。"
        : "添加本地文件，建立你的第一层书架。";
      $("recent").append(empty);
    }
    $("library-more").hidden = list.length <= visible;
  }
  async function refresh() {
    const state = await host.state();
    entries = state.library || state.recent;
    draw();
  }
  for (const id of ["library-query", "library-sort", "library-filter"])
    $(id).addEventListener("input", () => {
      visible = 48;
      draw();
    });
  $("library-more").onclick = () => {
    visible += 48;
    draw();
  };
  $("library-add").onclick = async () => {
    $("library-add").disabled = true;
    try {
      const result = await host.libraryAdd();
      await refresh();
      if (result.errors.length) message(result.errors.join("\n"));
    } catch (error) {
      message(error.message);
    } finally {
      $("library-add").disabled = false;
    }
  };
  return { refresh };
}
