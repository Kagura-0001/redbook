# Writing a Post

Read this before drafting any note, comment or reply template. The goal is to sound like someone in the circle, not like a summary of it. Copy that reads as agent-written gets spotted fast on XHS and costs the account trust.

## 1. Read the room first

About 10–15 reads, paced like any research (20–40 s apart, see [research-loop.md](research-loop.md)).

- Search 2–3 keywords: the niche term, and the niche term plus an emotion word. For example `流式视频 benchmark`, `benchmark 吐槽`, `科研 哭哭`. Use `--sort popular`, plus one `--sort latest` to see what people are saying this week.
- Read 4–6 top bodies with `read`, and 2–3 comment threads with `comments`. Comments are the best sample of how people actually talk; weigh them over bodies.
- Note the newest relevant posts. A live thread (someone asked "流式视频理解用什么bench" five days ago) is a hook worth replying to or building on.

## 2. Write down what you found

Keep these notes next to the draft:

- **Domain words the circle uses itself**: 伪流式, 必跑, 刷榜, 水paper, 撞车, 雕花, 叠甲. Use theirs rather than textbook terms (nobody says "回顾式的"; they say retrospective or 马后炮).
- **Hot phrases and memes** seen in `latest` results from this circle: 有点没招了, 天塌了, 急哭, 心累, 迷茫迷茫迷茫. Only use ones you actually saw recently.
- **Cross-domain metaphors that landed**: "AI界的石墨烯", "番茄炒蛋效果不好"式的bench, "科研的本质是卖大楼". Borrow the pattern, not the line.
- **Register**: is the circle venting (锐评) or self-deprecating (哭哭)? Criticism of other people's work goes down better as "我测懵了" than "它很烂". People who built those benchmarks are in the comments.
- **Stickers actually used**: `[哭惹R]` `[笑哭R]` `[doge]` `[暗中观察R]` `[失望R]`. `[doge]` reads as mocking; never aim it at someone's work.

## 3. Draft

- **Say less.** Facts, numbers and lists go on the image cards. The body is the person talking.
- **Uneven paragraphs.** One rambling line, then a five-word line. Not topic sentence → elaboration → conclusion in every paragraph, and not three paragraphs of equal length.
- **Short clauses**, spaces or commas instead of full stops, lowercase English terms (bench, eval, offline qa, sota).
- **Fillers and particles**: 吧 啊 嘛 咋 啥 感觉 其实 好像 算半个吧.
- **Avoid**: 本质上, 值得注意的是, 真正的, 不仅…而且, 越…越, 综上, em dashes, 1️⃣2️⃣3️⃣, 👉, parallel triplets, and operator lines like "评论区聊聊". End with a real question instead ("你们平时都用哪个bench啊 求推荐").
- **Credit before criticizing** (先叠个甲 这几个bench我自己也一直在用) and leave room to be wrong (可能我理解有问题 大佬们轻喷).
- **Titles**: at most 20 characters, and include the niche term so the post isn't routed to the wrong crowd (流式 alone pulls in 流式细胞 posts).
- **Facts on cards** must be checked against the source. Quote papers in their original language.

## 4. Check, then show the user

- Put the draft next to three real comments from step 1. If yours is longer, neater or more complete, cut.
- Show the whole post (title, body, card text, topics) to the user before rendering or posting.

## 5. Cards and publishing

- `redbook render post.md --pagination separator` with frontmatter `emoji`, `title`, `subtitle`, and `---` between cards. Cover titles wrap at about 10 CJK characters at the default 1080 px width; arrange the title so the break falls at punctuation. Use U+2011 for hyphens that shouldn't wrap (Real‑Time).
- Publish with `redbook draft <note-dir>`: it fills the creator center form in redbook's Chrome window and the user presses 发布 after a last look. Write stickers in post.md as emoji (the web editor doesn't turn `[哭惹R]` codes into stickers) and list topics in the frontmatter, not the body.
- `redbook post` publishes through the API and often draws a captcha (type 124), which pauses writes for 30 minutes. Keep it for cases where no browser is available.
