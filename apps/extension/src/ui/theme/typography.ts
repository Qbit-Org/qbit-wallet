const fonts = {
  ProtoMono: {
    bold: 'ProtoMono-Bold',
    regular: 'ProtoMono-Regular'
  },
  Inter: {
    bold: 'Inter-Bold',
    regular: 'Inter-Regular'
  }
};

export const typography = {
  /**
   * The fonts are available to use, but prefer using the semantic name.
   */
  fonts,
  /**
   * The primary font. Used in most places.
   */
  primary: fonts.Inter,
  heading: fonts.ProtoMono,
  mono: fonts.ProtoMono
};
