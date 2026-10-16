<script lang="ts">
    import type { Controller, JobStatus } from "./controller.svelte";
    import { sizeMB } from "./llm";
    import { displayName } from "./room";
    import { COMMANDS } from "./commands";

    let { c }: { c: Controller } = $props();

    let draft = $state("");
    let showContext = $state(false);

    $effect(() => {
        document.documentElement.dataset.theme = c.theme;
    });

    const gb = (mb: number): string => (mb / 1000).toFixed(1);
    const tokens = (n: number): string => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    const duration = (ms: number): string =>
        ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`;
    const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
    const embedded = $derived(c.room !== "standalone");
    const percent = $derived(Math.round(c.progress * 100));

    const statusLabel: Record<JobStatus, string> = {
        waiting: "waiting for model",
        generating: "generating…",
        posted: "posted to room",
        done: "done",
        skipped: "skipped",
        error: "error",
    };

    function submit(e: SubmitEvent): void {
        e.preventDefault();
        const text = draft.trim();
        if (!text) return;
        if (embedded) c.askPrivately(text);
        else c.say(text);
        draft = "";
    }

    function changed(): void {
        c.saveSettings();
    }
</script>

<main>
    <header>
        <h1>Room LLM</h1>
        <span class="pill {c.room}">
            {#if c.room === "standalone"}standalone{:else if c.room === "connecting"}connecting…{:else if c.room === "ready"}in room{:else}no permission{/if}
        </span>
    </header>

    {#if c.presence}
        {@const p = c.presence}
        <details class="presence">
            <summary>
                <b>{plural(p.open, "widget")}</b> open in this room · {p.ready} with a model ·
                <span class:warn={p.forUser === 0}>{p.forUser === 0 ? "none can answer you" : `${p.forUser} can answer you`}</span>
            </summary>
            <ul class="peers">
                {#each p.peers as peer (peer.instance)}
                    <li>
                        <b>{displayName(peer.sender) || "you"}</b>{peer.instance === c.instance ? " (this widget)" : ""}:
                        {#if peer.model}
                            {peer.model}, answers {peer.everyone ? "everyone" : "its owner only"} on <code>{peer.prefix}</code>
                        {:else}
                            open, no model loaded
                        {/if}
                    </li>
                {/each}
            </ul>
            <h2>Donated to this room</h2>
            {#if c.donors.length}
                <table>
                    <thead><tr><th>Who</th><th>Answers</th><th>Tokens read</th><th>Tokens written</th><th>GPU time</th></tr></thead>
                    <tbody>
                        {#each c.donors as d (d.user)}
                            <tr>
                                <td>{displayName(d.user)}</td>
                                <td>{d.donated.answers}</td>
                                <td>{tokens(d.donated.promptTokens)}</td>
                                <td>{tokens(d.donated.completionTokens)}</td>
                                <td>{duration(d.donated.gpuMs)}</td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            {:else}
                <p class="small muted">No answers posted yet.</p>
            {/if}
            <p class="small muted">
                Counted by each widget for answers it posted here, and shared when it announces itself.
                Widgets closed for a while drop out of the list once their last announcement scrolls out of the room's recent history.
            </p>
        </details>
    {/if}

    {#if c.room === "no-permission"}
        <p class="note warn">
            The widget may not read or post messages in this room. Approve the permission
            dialog, or reset this widget's permissions in your client.
        </p>
    {:else if c.missing.length > 0 && c.room === "ready"}
        <p class="note warn">Partly approved; missing: {c.missing.join(", ")}</p>
    {/if}

    {#if c.gpuProblem}
        <p class="note warn">{c.gpuProblem} Models run on your GPU, in this browser.</p>
    {/if}

    <section class="model">
        <label class="grow">
            <span>Model</span>
            <select bind:value={c.settings.modelId} onchange={changed} disabled={c.engineStatus === "loading" || c.useEcho}>
                {#each c.models as m (m.id)}
                    <option value={m.id}>{m.label} · {gb(sizeMB(m, c.f16))} GB{c.cached[m.id] ? " · cached" : ""}</option>
                {/each}
            </select>
        </label>
        {#if c.engineStatus === "ready"}
            <button type="button" class="secondary" onclick={() => c.unloadModel()}>Unload</button>
        {:else}
            <button type="button" onclick={() => c.loadModel()} disabled={c.engineStatus === "loading" || (!!c.gpuProblem && !c.useEcho)}>
                {c.engineStatus === "loading" ? "Loading…" : "Load model"}
            </button>
        {/if}
    </section>

    {#if c.engineStatus === "loading"}
        <progress max="100" value={percent}></progress>
        <p class="small muted">{c.progressText}</p>
    {:else if c.engineStatus === "ready"}
        <p class="small ok">Ready: {c.model}. Runs locally; nothing you or the room write leaves this browser.</p>
    {:else if c.engineStatus === "error"}
        <p class="note warn">{c.engineError}</p>
    {:else if !c.useEcho && c.selected && !c.cached[c.selected.id]}
        <p class="small muted">The first load downloads about {gb(sizeMB(c.selected, c.f16))} GB from Hugging Face; later loads come from the browser cache.</p>
    {/if}
    {#if !c.f16 && !c.gpuProblem && !c.useEcho}
        <p class="small muted">This GPU lacks shader-f16, so the larger f32 builds are used.</p>
    {/if}

    <details class="settings">
        <summary>How it answers</summary>
        <label>
            <span>Trigger</span>
            <input type="text" bind:value={c.settings.prefix} onchange={changed} size="6" />
        </label>
        <label class="check">
            <input type="checkbox" bind:checked={c.settings.postToRoom} onchange={changed} />
            <span>Post answers to the room (as a notice)</span>
        </label>
        <label class="check">
            <input type="checkbox" bind:checked={c.settings.answerEveryone} onchange={changed} disabled={!c.userId} />
            <span>Answer everyone's requests, not just mine</span>
        </label>
        {#if !c.userId && embedded}
            <p class="small muted">Your user id was not passed to the widget, so it answers everyone. Add <code>matrix_user_id=$matrix_user_id</code> to the widget URL to change that.</p>
        {/if}
        {#if c.model && c.chunk(c.model)}
            <p class="small muted">
                This GPU reset on long prompts, so this model reads them in parts of at most {c.chunk(c.model)} characters.
                <button type="button" class="link" onclick={() => { delete c.settings.chunks[c.model]; changed(); }}>reset</button>
            </p>
        {/if}
        <label>
            <span>Context: last</span>
            <input type="number" min="0" max="50" bind:value={c.settings.contextSize} onchange={changed} />
            <span>messages</span>
        </label>
    </details>

    <form onsubmit={submit}>
        <input
            type="text"
            bind:value={draft}
            placeholder={embedded ? "Ask about this room, or a shortcut like sum (private)…" : `Type a message; start with ${c.settings.prefix} to ask the model`}
            aria-label={embedded ? "Private question" : "Message"}
        />
        <button type="submit" disabled={!draft.trim()}>{embedded ? "Ask" : "Send"}</button>
    </form>

    {#if embedded}
        <p class="small muted">
            In the room, write <code>{c.settings.prefix} your question</code>. The model reads the
            last {c.settings.contextSize} messages and replies{c.settings.postToRoom ? " as a notice" : " here"}.
            Send it as a reply to make that message the one it works on.
        </p>
    {/if}

    <details class="shortcuts">
        <summary>Shortcuts</summary>
        <dl>
            {#each COMMANDS as cmd (cmd.names[0])}
                <dt><code>{c.settings.prefix} {cmd.usage}</code></dt>
                <dd>{cmd.help}</dd>
            {/each}
            <dt><code>{c.settings.prefix} help</code></dt>
            <dd>post this list to the room</dd>
        </dl>
        <p class="small muted">
            Commands that work on a message use the one you reply to, else text after the command,
            else the message just before. Words after other commands set the focus, e.g.
            <code>{c.settings.prefix} sum the budget</code>.
        </p>
    </details>

    <section class="jobs" aria-live="polite">
        {#each c.jobs as j (j.id)}
            <article class="job {j.status}">
                <div class="meta">
                    <span>{displayName(j.sender)}{j.triggerEventId ? "" : " (private)"}</span>
                    <span class="status">{statusLabel[j.status]}</span>
                    {#if j.status === "generating"}
                        <button type="button" class="link" onclick={() => c.stop()}>stop</button>
                    {/if}
                </div>
                <p class="question" title={j.question.length > 300 ? j.question.slice(0, 2000) : undefined}>{j.question || "(summarise)"}</p>
                {#if j.note}<p class="small muted">{j.note}</p>{/if}
                {#if j.usage && j.ms !== undefined && (j.status === "posted" || j.status === "done")}
                    <p class="small muted">{tokens(j.usage.promptTokens)} tokens read · {tokens(j.usage.completionTokens)} written · {duration(j.ms)}</p>
                {/if}
                {#if j.output}<p class="answer">{j.output}</p>{/if}
                {#if j.error}<p class="small warn">{j.error}</p>{/if}
            </article>
        {/each}
    </section>

    <details bind:open={showContext}>
        <summary>Conversation the model sees ({c.lines.length})</summary>
        {#if showContext}
            <ol class="transcript">
                {#each c.lines as l (l.eventId)}
                    <li class:model={l.fromModel}><b>{l.fromModel ? "assistant" : displayName(l.sender)}:</b> {l.body}</li>
                {/each}
            </ol>
        {/if}
    </details>
</main>
