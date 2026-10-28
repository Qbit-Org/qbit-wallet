import {
  ArrowUp,
  Bell,
  BookUser,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleCheck,
  CircleQuestionMark,
  Compass,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Fuel,
  Globe,
  History,
  Info,
  Link2,
  Lock,
  LucideIcon,
  MapPin,
  Network,
  Palette,
  QrCode,
  Rabbit,
  Send,
  Settings,
  SlidersHorizontal,
  TriangleAlert,
  Turtle,
  User,
  Wallet,
  X,
  Zap
} from 'lucide-react';
import React, { CSSProperties } from 'react';

import { ColorTypes, colors } from '@/ui/theme/colors';
import { fontSizes } from '@/ui/theme/font';

export const svgRegistry = {
  // tab
  qbitWallet: '/images/icons/tab/qbit-wallet.svg',

  // action
  delete: '/images/icons/action/delete.svg',
  sortAddress: '/images/icons/action/sort-address.svg',
  sortTop: '/images/icons/action/sort-top.svg',
  sortDrag: '/images/icons/action/sort-drag.svg',
  more: '/images/icons/action/more.svg',

  // status
  success: '/images/icons/status/success.svg',
  warning: '/images/icons/status/warning.svg',
  info: '/images/icons/status/info.svg',
  'error-boundary': '/images/icons/status/error-boundary.svg',
  emptyBox: '/images/icons/status/empty-box.svg',

  // settings
  addressBookEmpty: '/images/icons/settings/address-book-empty.svg',
  aboutus: '/images/icons/settings/aboutus.svg',
  'side-panel-logo': '/images/icons/settings/side-panel-logo.svg',
  'side-panel-logo-close': '/images/icons/settings/side-panel-logo-close.svg',
  'theme-light': '/images/icons/settings/theme-light.svg',
  'theme-dark': '/images/icons/settings/theme-dark.svg',
  'theme-system': '/images/icons/settings/theme-system.svg',

  // social
  discord: '/images/icons/social/discord.svg',
  twitter: '/images/icons/social/twitter.svg',
  website: '/images/icons/social/website.svg',

  // tx
  utxo: '/images/icons/tx/utxo.svg',
  psbt_input: '/images/icons/tx/psbt_input.svg',
  psbt_output: '/images/icons/tx/psbt_output.svg',
  psbt_opreturn: '/images/icons/tx/psbt_opreturn.svg',

  // action (balance toggles)
  'balance-eyes': '/images/icons/action/balance-eyes.svg',
  'balance-eyes-closed': '/images/icons/action/balance-eyes-closed.svg',
  'balance-question': '/images/icons/action/balance-question.svg',

  // artifacts
  'singer-info': '/images/icons/artifacts/singer-info.svg'
};

type LucideIconName =
  | 'right'
  | 'down'
  | 'up'
  | 'link'
  | 'arrowUp'
  | 'history'
  | 'send'
  | 'receive'
  | 'wallet'
  | 'user'
  | 'compass'
  | 'settings'
  | 'copy'
  | 'eye'
  | 'eye-slash'
  | 'close'
  | 'lock'
  | 'alert'
  | 'risk'
  | 'check'
  | 'checked'
  | 'circle'
  | 'circle-check'
  | 'circle-info'
  | 'circle-question'
  | 'notification'
  | 'language'
  | 'connectedSites'
  | 'addressBook'
  | 'addressType'
  | 'appearance'
  | 'advance'
  | 'aboutUsLogo'
  | 'network'
  | 'gas'
  | 'fee-low'
  | 'fee-medium'
  | 'fee-high';

const trueColorIconList: Array<IconTypes> = [
  'success',
  'delete',
  'aboutus',
  'error-boundary',
  'addressBookEmpty',
  'psbt_input',
  'psbt_output',
  'psbt_opreturn',
  'emptyBox',
];

export type IconTypes = keyof typeof svgRegistry | LucideIconName;

const lucideRegistry: Partial<Record<IconTypes, LucideIcon>> = {
  // nav
  right: ChevronRight,
  down: ChevronDown,
  up: ChevronUp,
  link: ExternalLink,
  arrowUp: ArrowUp,
  history: History,

  // tab
  user: User,
  compass: Compass,
  settings: Settings,

  // header
  wallet: Wallet,

  // action
  send: Send,
  receive: QrCode,
  copy: Copy,
  eye: Eye,
  'eye-slash': EyeOff,
  close: X,
  lock: Lock,

  // status
  alert: TriangleAlert,
  risk: TriangleAlert,
  check: Check,
  checked: CircleCheck,
  circle: Circle,
  'circle-check': CircleCheck,
  'circle-info': Info,
  'circle-question': CircleQuestionMark,
  notification: Bell,

  // settings
  language: Globe,
  connectedSites: Link2,
  addressBook: BookUser,
  addressType: MapPin,
  appearance: Palette,
  advance: SlidersHorizontal,
  aboutUsLogo: Info,
  network: Network,

  // protocol
  gas: Fuel,

  // fee priority
  'fee-low': Turtle,
  'fee-medium': Rabbit,
  'fee-high': Zap
};
interface IconProps {
  /**
   * The name of the icon
   */
  icon?: IconTypes;

  /**
   * An optional tint color for the icon
   */
  color?: ColorTypes;

  /**
   * An optional size for the icon..
   */
  size?: number | string;

  /**
   * Style overrides for the icon image
   */
  style?: CSSProperties;

  /**
   * Style overrides for the icon container
   */
  containerStyle?: CSSProperties;

  /**
   * An optional function to be called when the icon is clicked
   */
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  children?: React.ReactNode;
  'data-testid'?: string;
}

export function Icon(props: IconProps) {
  const {
    icon,
    color,
    size,
    style: $imageStyleOverride,
    containerStyle: $containerStyleOverride,
    onClick,
    children,
    'data-testid': dataTestId
  } = props;
  if (!icon) {
    return (
      <div
        onClick={onClick}
        style={Object.assign(
          {},
          {
            color: color ? colors[color] : colors.text,
            fontSize: size || fontSizes.icon,
            display: 'flex'
          } as CSSProperties,
          $containerStyleOverride,
          $imageStyleOverride || {},
          onClick ? { cursor: 'pointer' } : {}
        )}
        data-testid={dataTestId}
      >
        {children}
      </div>
    );
  }
  const iconPath = (svgRegistry as Partial<Record<IconTypes, string>>)[icon];
  const { backgroundColor: styleTintColor, ...imageStyleOverride } = $imageStyleOverride || {};
  const tintColor = color ? colors[color] : styleTintColor;
  const LucideGlyph = lucideRegistry[icon];
  if (LucideGlyph) {
    return (
      <div style={$containerStyleOverride}>
        <LucideGlyph
          onClick={onClick as unknown as React.MouseEventHandler<SVGSVGElement>}
          size={size || fontSizes.icon}
          color={tintColor || colors.text}
          style={Object.assign(
            {},
            { display: 'block' } as CSSProperties,
            imageStyleOverride,
            onClick ? { cursor: 'pointer' } : {}
          )}
          data-testid={dataTestId}
        />
      </div>
    );
  }
  if (trueColorIconList.includes(icon) && !color) {
    return (
      <img
        onClick={onClick}
        src={iconPath}
        alt=""
        style={Object.assign(
          {},
          $containerStyleOverride,
          {
            width: size || fontSizes.icon,
            height: size || fontSizes.icon,
            cursor: onClick ? 'pointer' : 'default'
          },
          imageStyleOverride
        )}
      />
    );
  }
  if (iconPath) {
    return (
      <div style={$containerStyleOverride}>
        <div
          onClick={onClick}
          style={Object.assign(
            {},
            {
              color: color ? colors[color] : colors.text,
              width: size || fontSizes.icon,
              height: size || fontSizes.icon,
              backgroundColor: tintColor || colors.text,
              maskImage: `url(${iconPath})`,
              maskSize: 'contain',
              maskRepeat: 'no-repeat',
              maskPosition: 'center',
              WebkitMaskImage: `url(${iconPath})`,
              WebkitMaskSize: 'contain',
              WebkitMaskRepeat: 'no-repeat',
              WebkitMaskPosition: 'center'
            },
            imageStyleOverride,
            onClick ? { cursor: 'pointer' } : {}
          )}
          data-testid={dataTestId}
        />
      </div>
    );
  } else {
    return <div />;
  }
}
