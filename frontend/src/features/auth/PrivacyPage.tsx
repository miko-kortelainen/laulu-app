import { Link } from "react-router";

export function PrivacyPage() {
  return (
    <main className="mx-auto min-h-0 w-full max-w-2xl flex-1 overflow-y-auto px-5 py-8 sm:py-12">
      <article className="space-y-7 text-sm leading-relaxed text-zinc-300" aria-labelledby="privacy-title">
        <header>
          <h1 id="privacy-title" className="text-2xl font-semibold text-zinc-100">privacy and beta limits</h1>
          <p className="mt-2 text-xs text-zinc-400">lau.lu beta · updated 8 October 2026</p>
        </header>
        <section className="space-y-2" aria-labelledby="privacy-storage">
          <h2 id="privacy-storage" className="text-base font-semibold text-zinc-100">what is stored</h2>
          <p>Supabase stores your account details, sign-in information, daily usage, song metadata, and temporary request results. Saved song audio is stored in a private Cloudflare R2 bucket. The app lets you access only your own songs and uploads.</p>
          <p>Saved songs stay until you delete them from my songs. Temporary request results can include assistant replies, song briefs, and lyrics. Finished request records and unsaved song recovery files are eligible for cleanup after seven days.</p>
        </section>
        <section className="space-y-2" aria-labelledby="privacy-processing">
          <h2 id="privacy-processing" className="text-base font-semibold text-zinc-100">AI processing</h2>
          <p>Chat messages, conversation context, song briefs, and lyric requests are sent to Nebius. Approved song prompts and lyrics are sent to Google for music generation. Selected audio and your question are sent to QwenCloud when you request audio analysis. These requests pass through Cloudflare AI Gateway.</p>
          <p>These services process the data under their own policies. Avoid uploading or entering sensitive information. LangSmith tracing is disabled in the production beta.</p>
        </section>
        <section className="space-y-2" aria-labelledby="privacy-temporary">
          <h2 id="privacy-temporary" className="text-base font-semibold text-zinc-100">temporary uploads and chat</h2>
          <p>Uploaded audio stays on the app server for your session. It is deleted after logout, chat reset, 30 minutes of inactivity, or a backend restart. Active work can delay deletion until it finishes.</p>
          <p>Chat history is held in server memory and can reset after inactivity or a restart. Your browser stores your sign-in session and keeps the music draft in the current tab, separately for each account.</p>
        </section>
        <section className="space-y-2" aria-labelledby="privacy-limits">
          <h2 id="privacy-limits" className="text-base font-semibold text-zinc-100">beta limits</h2>
          <p>The chat page shows your current daily allowances and reset time. Shared daily limits also apply, so requests can stop even when you have personal allowance left. Daily limits reset at midnight UTC.</p>
          <p>A completed song uses one generation allowance. A confirmed generation failure restores personal allowance; an unknown outcome keeps it reserved. Retrying a failed save does not generate another song. Deleting a song does not restore daily generation allowance.</p>
          <p>Uploads must be MP3, WAV, FLAC, or OGG, up to 50 MiB and ten minutes long. The beta can have interruptions. Download songs you want to keep.</p>
        </section>
        <section className="space-y-2" aria-labelledby="privacy-contact">
          <h2 id="privacy-contact" className="text-base font-semibold text-zinc-100">contact and deletion requests</h2>
          <p>For privacy questions, access requests, or account deletion, email <a href="mailto:miko@kortelainen.dev" className="break-all underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300">miko@kortelainen.dev</a>. You can delete individual saved songs from my songs.</p>
        </section>
        <Link to="/" className="inline-flex min-h-11 items-center rounded-lg underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300">back to app</Link>
      </article>
    </main>
  );
}
