import { Link } from "react-router";

const linkClass = "underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300";

export function TermsPage() {
  return (
    <main className="mx-auto min-h-0 w-full max-w-2xl flex-1 overflow-y-auto px-5 py-8 sm:py-12">
      <article className="space-y-7 text-sm leading-relaxed text-zinc-300" aria-labelledby="terms-title">
        <header>
          <h1 id="terms-title" className="text-2xl font-semibold text-zinc-100">terms of service</h1>
          <p className="mt-2 text-xs text-zinc-400">lau.lu beta · updated 12 October 2026</p>
        </header>
        <section className="space-y-2" aria-labelledby="terms-acceptance">
          <h2 id="terms-acceptance" className="text-base font-semibold text-zinc-100">using lau.lu</h2>
          <p>By creating an account or using lau.lu, you agree to these terms. If you do not agree, do not use the service. The <Link to="/privacy" className={linkClass}>privacy and beta limits</Link> page explains what is stored and how AI processing works, and forms part of these terms.</p>
          <p>You must be at least 13 years old, or older if your country requires it, or have permission from a parent or guardian. You must provide accurate account details, keep your sign-in secure, and are responsible for activity under your account. For any question about these terms, contact <a href="mailto:miko@kortelainen.dev" className={`break-all ${linkClass}`}>miko@kortelainen.dev</a>.</p>
          <p>lau.lu, including its software, design, and name, belongs to its operator and licensors. These terms do not give you any right to it beyond normal use of the service.</p>
        </section>
        <section className="space-y-2" aria-labelledby="terms-use">
          <h2 id="terms-use" className="text-base font-semibold text-zinc-100">acceptable use</h2>
          <p>Use lau.lu only for lawful purposes. Do not upload or enter sensitive information, content you do not have the rights to use, or material that infringes the rights of others. Do not attempt to disrupt the service, bypass daily limits or access controls, scrape or overload it, or access another person&apos;s songs or uploads.</p>
          <p>Do not use lau.lu or its output to break the law, deceive others, imply endorsement by an artist or another person, impersonate someone, or distribute unlawful or harmful content. Do not ask for output that is meant to copy a protected work or a person&apos;s voice or identity. We can remove content, suspend use, or close an account that breaks these terms.</p>
        </section>
        <section className="space-y-2" aria-labelledby="terms-content">
          <h2 id="terms-content" className="text-base font-semibold text-zinc-100">your content and AI output</h2>
          <p>You keep any rights you already hold in briefs, lyrics, and audio you provide, and you confirm you have the rights needed to provide them. You grant lau.lu only the permission needed to process your requests, generate songs, and store saved songs for you.</p>
          <p>As between you and lau.lu, lau.lu does not claim ownership of songs the service generates from your brief. Subject to the law, the rights of others, and any terms of the AI providers used to generate it, you may use generated output for personal and commercial purposes. Output is not exclusive to you: similar output may be generated for others, and lau.lu cannot grant rights it does not hold.</p>
          <p>AI-generated songs and replies can be inaccurate, incomplete, unoriginal, or similar to existing works. You are responsible for checking output and clearing any rights before sharing, publishing, selling, or otherwise using it, and for complying with the law where you use it.</p>
        </section>
        <section className="space-y-2" aria-labelledby="terms-copyright">
          <h2 id="terms-copyright" className="text-base font-semibold text-zinc-100">copyright complaints</h2>
          <p>If you believe content on lau.lu infringes your copyright, email <a href="mailto:miko@kortelainen.dev" className={`break-all ${linkClass}`}>miko@kortelainen.dev</a> with your name and contact details, a description of your work, where the infringing content can be found, and a statement that you believe in good faith that the use is not authorised. We will review the complaint and, where appropriate, remove or disable access to the content.</p>
          <p>We can close accounts of repeat infringers. If your content was removed by mistake, email the same address with the details and we will review it again.</p>
        </section>
        <section className="space-y-2" aria-labelledby="terms-beta">
          <h2 id="terms-beta" className="text-base font-semibold text-zinc-100">beta limits and availability</h2>
          <p>lau.lu is a free beta. Features, daily allowances, and shared limits can change, pause, or stop, and prices or paid features can be introduced later under updated terms. Requests can fail or be interrupted, and chat or temporary results can reset. Download songs you want to keep.</p>
          <p>Your current daily allowances and reset time are shown in my profile. A completed song uses one generation allowance, as described on the <Link to="/privacy" className={linkClass}>privacy and beta limits</Link> page.</p>
        </section>
        <section className="space-y-2" aria-labelledby="terms-responsibility">
          <h2 id="terms-responsibility" className="text-base font-semibold text-zinc-100">responsibility for your use</h2>
          <p>If a claim, loss, or cost arises because of content you provided, output you chose to use, or your breach of these terms, you are responsible for it to the extent caused by you and allowed by law. This does not affect responsibility that lau.lu cannot shift to you by law.</p>
        </section>
        <section className="space-y-2" aria-labelledby="terms-liability">
          <h2 id="terms-liability" className="text-base font-semibold text-zinc-100">no warranty and liability</h2>
          <p>The beta is provided as is, without warranties of any kind, including that it will be available, error-free, or fit for a particular purpose. To the extent allowed by law, lau.lu is not liable for lost songs, lost data, interrupted service, or losses that follow from relying on AI output.</p>
          <p>Nothing in these terms excludes or limits liability that cannot be excluded or limited by law, or your mandatory consumer rights, including your right to a service that matches its description.</p>
        </section>
        <section className="space-y-2" aria-labelledby="terms-ending">
          <h2 id="terms-ending" className="text-base font-semibold text-zinc-100">ending access</h2>
          <p>You can stop using lau.lu at any time and delete saved songs from my songs. For account deletion, email <a href="mailto:miko@kortelainen.dev" className={`break-all ${linkClass}`}>miko@kortelainen.dev</a>. We can suspend or end access if you break these terms, if the beta ends, or where required by law.</p>
          <p>When access ends, saved songs and account content can be deleted as described on the <Link to="/privacy" className={linkClass}>privacy and beta limits</Link> page. Sections on content rights, copyright, responsibility, liability, and governing law still apply after access ends.</p>
        </section>
        <section className="space-y-2" aria-labelledby="terms-changes">
          <h2 id="terms-changes" className="text-base font-semibold text-zinc-100">changes and other terms</h2>
          <p>We can update these terms for the beta. For a material change, we will announce it in the app or by email before it takes effect where reasonably possible, and the updated date above will change. Continued use after the change takes effect means you accept it. If you do not accept a change, stop using lau.lu and ask for account deletion.</p>
          <p>These terms and the <Link to="/privacy" className={linkClass}>privacy and beta limits</Link> page are the whole agreement for lau.lu. If a part of these terms cannot be enforced, the rest still applies. Not enforcing a term once is not a waiver. You cannot transfer your account or these terms without our written consent. We can transfer the service or these terms if the service changes operator, and will announce it as a material change.</p>
        </section>
        <section className="space-y-2" aria-labelledby="terms-law">
          <h2 id="terms-law" className="text-base font-semibold text-zinc-100">governing law and disputes</h2>
          <p>These terms are governed by the laws of Finland. Please email <a href="mailto:miko@kortelainen.dev" className={`break-all ${linkClass}`}>miko@kortelainen.dev</a> first so we can try to resolve any dispute informally. If that fails, disputes will be heard by the courts of Finland, unless mandatory consumer law gives you the right to bring a claim where you live or requires another forum.</p>
        </section>
        <Link to="/" className="inline-flex min-h-11 items-center rounded-lg underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300">back to app</Link>
      </article>
    </main>
  );
}
