class I18n {
  t = (key: string, substitutions?: string | string[]): string => {
    console.log('i18n t called in bg class', key, substitutions)
    return key
  }

  changeLanguage = async (locale: string) => {
    console.log('i18n changeLanguage called in bg class', locale)
  }
}

const bgI18n = new I18n()

const t = (key: string, substitutions?: string | string[]): string => {
  return bgI18n.t(key, substitutions)
}

export { bgI18n, t }
