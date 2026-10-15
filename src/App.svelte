<script lang="ts">
    import type { Controller, JobStatus } from "./controller.svelte";
    import { sizeMB } from "./llm";
    import { displayName } from "./room";

    let { c }: { c: Controller } = $props();

    let draft = $state("");
    let showContext = $state(false);

    $effect(() => {
        document.documentElement.dataset.theme = c.theme;
    });

    const gb = (mb: number): string => (mb / 1000).toFixed(1);
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
        {#if c.model && c.budget(c.model) < 9000}
            <p class="small muted">
                After GPU resets, prompts for this model are limited to {c.budget(c.model)} characters on this machine.
                <button type="button" class="link" onclick={() => { delete c.settings.budgets[c.model]; changed(); }}>reset</button>
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
            placeholder={embedded ? "Ask about this room (private)…" : `Type a message; start with ${c.settings.prefix} to ask the model`}
            aria-label={embedded ? "Private question" : "Message"}
        />
        <button type="submit" disabled={!draft.trim()}>{embedded ? "Ask" : "Send"}</button>
    </form>

    {#if embedded}
        <p class="small muted">
            In the room, write <code>{c.settings.prefix} your question</code>. The model reads the
            last {c.settings.contextSize} messages and replies{c.settings.postToRoom ? " as a notice" : " here"}.
        </p>
    {/if}

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
