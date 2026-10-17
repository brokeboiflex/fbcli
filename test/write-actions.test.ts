import { describe, expect, test } from "bun:test";

import { FBError } from "../src/browser.ts";
import * as A from "../src/web-actions.ts";
import { page, probe, RECORDER, withFakeFB } from "./fake-facebook.ts";

// These drive a real browser through deliberately patient waits (the production
// code waits on Facebook's async hydration), so give each test room to breathe.
const TIMEOUT = 120_000;

/**
 * A composer surface: a visible opener that mounts the real "Create post" modal,
 * plus the two decoys the Python selectors were written to dodge — a background
 * inline editor and a dialog with no editor in it.
 */
function composerPage(
  openerText: string,
  opts: { graphql?: boolean; audience?: string } = {},
): string {
  const fetchCall = opts.graphql
    ? `fetch('/api/graphql', {method:'POST',headers:{'x-fb-friendly-name':'ComposerStoryCreateMutation'}}).then(function(r){return r.text()}).then(finish)`
    : `finish()`;
  const audienceBtn = opts.audience
    ? `'<div id="aud" role="button" tabindex="0">${opts.audience}</div>' +`
    : "";
  return page(`${RECORDER}
    <div role="main">
      <div id="opener" tabindex="0" style="padding:20px">${openerText}</div>
      <div id="decoy-inline" role="textbox" contenteditable="true" style="height:30px">background editor</div>
    </div>
    <div role="dialog" id="decoy-dialog">a dialog with no editor</div>
    <script>
      document.getElementById('opener').addEventListener('click', function () {
        if (document.getElementById('composer')) return;
        var d = document.createElement('div');
        d.id = 'composer';
        d.setAttribute('role', 'dialog');
        d.innerHTML =
          ${audienceBtn}
          '<div id="editor" role="textbox" contenteditable="true" style="height:60px"></div>' +
          '<div id="postbtn" role="button" tabindex="0" aria-disabled="true">Post</div>';
        document.body.appendChild(d);
        var ed = document.getElementById('editor');
        var btn = document.getElementById('postbtn');
        ed.addEventListener('input', function () {
          btn.setAttribute('aria-disabled', ed.textContent ? 'false' : 'true');
        });
        function finish() { d.remove(); }
        btn.addEventListener('click', function () {
          if (btn.getAttribute('aria-disabled') === 'true') return;
          window.__fb.posted = ed.textContent;
          window.__fb.decoyTyped = document.getElementById('decoy-inline').textContent;
          ${fetchCall};
        });
      });
    </script>`);
}

const GRAPHQL_BODY = JSON.stringify({
  data: {
    story_create: { story: { url: "https:\\/\\/www.facebook.com\\/x\\/posts\\/pfbid0CANONICAL" } },
  },
});

describe("postStatus", () => {
  test(
    "types into the modal editor, clicks Post, and returns the pfbid permalink",
    async () => {
      await withFakeFB(
        {
          html: { "*": composerPage("What's on your mind, Jane?", { graphql: true }) },
          json: { "/api/graphql": GRAPHQL_BODY },
        },
        async (b) => {
          const post = await A.postStatus(b, "Posted straight from my terminal 🐧");
          expect(post.author).toBe("you");
          expect(post.text).toBe("Posted straight from my terminal 🐧");
          expect(post.permalink).toBe(
            "https://www.facebook.com/100000000000000/posts/pfbid0CANONICAL",
          );
        },
      );
    },
    TIMEOUT,
  );

  test(
    "scopes typing to the modal, never the background editor",
    async () => {
      await withFakeFB(
        { html: { "*": composerPage("What's on your mind?") } },
        async (b) => {
          await A.postStatus(b, "hello world");
          // The page re-renders on navigation, so read the recorder before it goes.
          expect(await probe(b, "posted")).toBe("hello world");
          expect(await probe(b, "decoyTyped")).toBe("background editor");
        },
      );
    },
    TIMEOUT,
  );

  test.each([
    "Write something...",
    "Start a discussion",
    "Discuss something",
    "Say something about this",
    "Whats on your mind",
  ])(
    "recognises the %p composer opener",
    async (opener) => {
      await withFakeFB({ html: { "*": composerPage(opener) } }, async (b) => {
        await A.postStatus(b, "hi group");
        expect(await probe(b, "posted")).toBe("hi group");
      });
    },
    TIMEOUT,
  );

  test(
    "posts into a group and falls back to the group URL without a graphql id",
    async () => {
      await withFakeFB(
        { html: { "*": composerPage("Write something") } },
        async (b) => {
          const post = await A.postStatus(b, "hi group", "https://www.facebook.com/groups/777/");
          expect(new URL(b.page.url()).pathname).toBe("/groups/777/");
          expect(post.permalink).toBe("https://www.facebook.com/groups/777");
        },
      );
    },
    TIMEOUT,
  );

  test(
    "falls back to the profile URL on a timeline post with no graphql id",
    async () => {
      await withFakeFB(
        { html: { "*": composerPage("What's on your mind?") } },
        async (b) => {
          const post = await A.postStatus(b, "hi");
          expect(post.permalink).toBe(
            "https://www.facebook.com/profile.php?id=100000000000000",
          );
        },
      );
    },
    TIMEOUT,
  );

  test(
    "raises FBError when no composer modal ever mounts",
    async () => {
      const html = page(`${RECORDER}<div role="main">
        <div id="opener">What's on your mind?</div>
      </div>`);
      await withFakeFB({ html: { "*": html } }, async (b) => {
        await expect(A.postStatus(b, "hi")).rejects.toThrow(FBError);
        await expect(A.postStatus(b, "hi")).rejects.toThrow(
          "Could not open the post composer (layout changed?).",
        );
      });
    },
    TIMEOUT,
  );
});

describe("postStatus --audience guard", () => {
  test(
    "publishes when the composer audience matches",
    async () => {
      await withFakeFB(
        { html: { "*": composerPage("What's on your mind?", { audience: "Friends" }) } },
        async (b) => {
          await A.postStatus(b, "friends only", null, "friends");
          expect(await probe(b, "posted")).toBe("friends only");
        },
      );
    },
    TIMEOUT,
  );

  test(
    "refuses to publish when the audience does not match",
    async () => {
      await withFakeFB(
        { html: { "*": composerPage("What's on your mind?", { audience: "Public" }) } },
        async (b) => {
          await expect(A.postStatus(b, "oops", null, "friends")).rejects.toThrow(
            /Composer audience is 'Public', not 'Friends'/,
          );
          // The guard fires before the click, so nothing was published.
          expect(await probe(b, "posted")).toBeUndefined();
        },
      );
    },
    TIMEOUT,
  );

  test(
    "fails closed when the audience selector can't be read",
    async () => {
      await withFakeFB(
        { html: { "*": composerPage("What's on your mind?") } }, // no audience button
        async (b) => {
          await expect(A.postStatus(b, "oops", null, "public")).rejects.toThrow(
            /Could not read the composer audience/,
          );
          expect(await probe(b, "posted")).toBeUndefined();
        },
      );
    },
    TIMEOUT,
  );

  test(
    "rejects --audience on a group post",
    async () => {
      await withFakeFB({ html: { "*": composerPage("Write something") } }, async (b) => {
        await expect(
          A.postStatus(b, "hi", "https://www.facebook.com/groups/777/", "public"),
        ).rejects.toThrow(/--audience applies to timeline posts/);
      });
    },
    TIMEOUT,
  );
});

describe("comment", () => {
  test(
    "types into the comment box and submits with Enter",
    async () => {
      const html = page(`${RECORDER}<div role="main">
        <div id="cbox" aria-label="Comment as Jane Doe" role="textbox" contenteditable="true" style="height:30px"></div>
        <script>
          document.getElementById('cbox').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { window.__fb.comment = this.textContent; this.textContent = ''; }
          });
        </script>
      </div>`);
      await withFakeFB({ html: { "*": html } }, async (b) => {
        expect(await A.comment(b, "/jane/posts/1", "great write-up!")).toBe("commented");
        expect(await probe(b, "comment")).toBe("great write-up!");
      });
    },
    TIMEOUT,
  );
});

describe("react", () => {
  const html = page(`${RECORDER}<div role="main">
    <div id="like" role="button" tabindex="0" style="padding:10px">Like</div>
    <div id="picker" style="display:none">
      <div role="button" tabindex="0" style="padding:10px">Love</div>
      <div role="button" tabindex="0" style="padding:10px">Haha</div>
    </div>
    <script>
      var like = document.getElementById('like');
      like.addEventListener('mouseenter', function () {
        document.getElementById('picker').style.display = 'block';
      });
      like.addEventListener('click', function () { window.__fb.reaction = 'like'; });
      document.querySelectorAll('#picker [role=button]').forEach(function (el) {
        el.addEventListener('click', function () {
          window.__fb.reaction = el.textContent.toLowerCase();
        });
      });
    </script>
  </div>`);

  test(
    "clicks Like directly for the default reaction",
    async () => {
      await withFakeFB({ html: { "*": html } }, async (b) => {
        expect(await A.react(b, "/jane/posts/1")).toBe("reacted: like");
        expect(await probe(b, "reaction")).toBe("like");
      });
    },
    TIMEOUT,
  );

  test(
    "hovers to open the picker and clicks the named reaction",
    async () => {
      await withFakeFB({ html: { "*": html } }, async (b) => {
        expect(await A.react(b, "/jane/posts/1", "love")).toBe("reacted: love");
        expect(await probe(b, "reaction")).toBe("love");
        expect(await A.react(b, "/jane/posts/1", "HAHA")).toBe("reacted: HAHA");
        expect(await probe(b, "reaction")).toBe("haha");
      });
    },
    TIMEOUT,
  );

  test(
    "falls back to a plain Like when the reaction isn't in the picker",
    async () => {
      await withFakeFB({ html: { "*": html } }, async (b) => {
        expect(await A.react(b, "/jane/posts/1", "angry")).toBe("reacted: like (fallback)");
        expect(await probe(b, "reaction")).toBe("like");
      });
    },
    TIMEOUT,
  );
});

describe("group membership", () => {
  test(
    "joins a group by clicking its Join button",
    async () => {
      const html = page(`${RECORDER}<div role="main">
        <div id="join" role="button" tabindex="0" style="padding:10px">Join group</div>
        <script>
          document.getElementById('join').addEventListener('click', function () {
            window.__fb.joined = true; this.textContent = 'Joined';
          });
        </script>
      </div>`);
      await withFakeFB({ html: { "*": html } }, async (b) => {
        expect(await A.joinGroup(b, "123")).toBe("join clicked (request sent or joined)");
        expect(await probe(b, "joined")).toBe(true);
      });
    },
    TIMEOUT,
  );

  test(
    "reports an existing membership when there is no Join button",
    async () => {
      const html = page(`${RECORDER}<div role="main">
        <div role="button" tabindex="0">Joined</div>
      </div>`);
      await withFakeFB({ html: { "*": html } }, async (b) => {
        expect(await A.joinGroup(b, "123")).toBe("already a member");
      });
    },
    TIMEOUT,
  );

  test(
    "raises FBError for a group it can neither join nor is in",
    async () => {
      await withFakeFB({ html: { "*": page(`${RECORDER}<div role="main">secret</div>`) } }, async (b) => {
        await expect(A.joinGroup(b, "123")).rejects.toThrow(
          "No Join button found (group may be secret/invite-only).",
        );
      });
    },
    TIMEOUT,
  );

  test(
    "leaves a group through the Joined menu and the confirm dialog",
    async () => {
      const html = page(`${RECORDER}<div role="main">
        <div id="joined" role="button" tabindex="0" style="padding:10px">Joined</div>
        <div id="menu" style="display:none"><div role="menuitem" tabindex="0" style="padding:10px">Leave group</div></div>
        <div id="confirm" style="display:none"><div role="button" tabindex="0" style="padding:10px">Leave group</div></div>
        <script>
          document.getElementById('joined').addEventListener('click', function () {
            document.getElementById('menu').style.display = 'block';
          });
          document.querySelector('#menu [role=menuitem]').addEventListener('click', function () {
            window.__fb.menu = true;
            document.getElementById('confirm').style.display = 'block';
          });
          document.querySelector('#confirm [role=button]').addEventListener('click', function () {
            window.__fb.left = true;
          });
        </script>
      </div>`);
      await withFakeFB({ html: { "*": html } }, async (b) => {
        expect(await A.leaveGroup(b, "/groups/123")).toBe("left group");
        expect(await probe(b, "menu")).toBe(true);
        expect(await probe(b, "left")).toBe(true);
      });
    },
    TIMEOUT,
  );
});

describe("createGroup", () => {
  test(
    "types the name, picks the privacy option, and reads back the new group id",
    async () => {
      const html = page(`${RECORDER}<div role="main">
        <input id="gname" autofocus style="padding:4px">
        <div id="privacy" role="combobox" tabindex="0" style="padding:10px">Choose privacy</div>
        <div id="options" style="display:none">
          <div role="option" tabindex="0" style="padding:10px">Private</div>
          <div role="option" tabindex="0" style="padding:10px">Public</div>
        </div>
        <div id="create" role="button" tabindex="0" style="padding:10px">Create</div>
        <script>
          document.getElementById('gname').focus();
          document.getElementById('privacy').addEventListener('click', function () {
            document.getElementById('options').style.display = 'block';
          });
          document.querySelectorAll('#options [role=option]').forEach(function (el) {
            el.addEventListener('click', function () {
              window.__fb.privacy = el.textContent;
              document.getElementById('privacy').textContent = el.textContent;
            });
          });
          document.getElementById('create').addEventListener('click', function () {
            window.__fb.name = document.getElementById('gname').value;
            sessionStorage.setItem('fb', JSON.stringify(window.__fb));
            location.href = '/groups/987654321';
          });
        </script>
      </div>`);
      await withFakeFB(
        {
          html: {
            "/groups/create": html,
            "/groups/987654321": page(`<script>window.__fb = JSON.parse(sessionStorage.getItem('fb') || '{}')</script><div role="main">your new group</div>`),
          },
        },
        async (b) => {
          const g = await A.createGroup(b, "my sandbox", "private");
          expect(g).toEqual({
            name: "my sandbox",
            id: "987654321",
            url: "https://www.facebook.com/groups/987654321",
          });
          expect(await probe(b, "name")).toBe("my sandbox");
          expect(await probe(b, "privacy")).toBe("Private");
        },
      );
    },
    TIMEOUT,
  );
});

describe("sendMessage", () => {
  test(
    "opens the thread and submits the message with Enter",
    async () => {
      const html = page(`${RECORDER}<div role="main">
        <div id="msg" role="textbox" aria-label="Message" contenteditable="true" style="height:30px"></div>
        <script>
          document.getElementById('msg').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { window.__fb.sent = this.textContent; this.textContent = ''; }
          });
        </script>
      </div>`);
      await withFakeFB({ html: { "*": html } }, async (b) => {
        expect(await A.sendMessage(b, "100000000000000", "hey")).toBe("sent");
        expect(new URL(b.page.url()).pathname).toBe("/messages/t/100000000000000");
        expect(await probe(b, "sent")).toBe("hey");

        await A.sendMessage(b, "/jane.doe", "hi there");
        expect(new URL(b.page.url()).pathname).toBe("/messages/t/jane.doe");
        expect(await probe(b, "sent")).toBe("hi there");
      });
    },
    TIMEOUT,
  );
});
