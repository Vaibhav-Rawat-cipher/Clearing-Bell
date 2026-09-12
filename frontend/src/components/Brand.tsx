export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="cb-brand" aria-label="Clearing Bell">
      <svg className="cb-brand-symbol" viewBox="0 0 34 34" aria-hidden="true">
        <path d="M4 9.5 17 3l13 6.5-13 6.4L4 9.5Z" />
        <path d="m4 17 13 6.5L30 17" />
        <path d="m4 24.4 13 6.5 13-6.5" />
      </svg>
      {!compact && <span className="cb-wordmark">clearing<span>/</span>bell</span>}
    </span>
  )
}
