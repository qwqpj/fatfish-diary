/**
 * avatar.js — 大肥鱼的自画像（纯手写 SVG，零外部资源）。
 *
 * 形象依据用户提供的官方风格表情包：深蓝（藏青）女仆装 + 白色蕾丝荷叶边围裙、
 * 围裙正中一个蓝色小鲸鱼、蓝色长发（深→浅渐变）、头两侧鲸鱼鳍一样的"耳朵"、
 * 身后鲸鱼尾巴、白色蕾丝女仆头饰、侧面一个小蓝蝴蝶结，端着一碗白饭。
 */

/** 鲸鱼侧影路径（0..24 视口，尾鳍在左）—— 自画像的围裙 logo 与侧栏图标共用 */
const WHALE_BODY =
  "M12.8 5.4C17.8 5.4 21.6 8.6 21.6 12.4C21.6 16.2 17.8 19.4 12.8 19.4" +
  "C9.6 19.4 6.7 18.1 5 16.1L1.6 17.8L3.4 12.4L1.6 7L5.1 8.7" +
  "C6.8 6.7 9.6 5.4 12.8 5.4Z";
const WHALE_EYE =
  "M16.5 10.1C17.3 10.1 17.9 10.7 17.9 11.5C17.9 12.3 17.3 12.9 16.5 12.9" +
  "C15.7 12.9 15.1 12.3 15.1 11.5C15.1 10.7 15.7 10.1 16.5 10.1Z";

export function avatarSvg({ size = 96 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="${size}" height="${size}" role="img" aria-label="吃白饭的大肥鱼">
  <defs>
    <linearGradient id="ffHair" x1="0" y1="0" x2="0.25" y2="1">
      <stop offset="0%" stop-color="#5c9ae0"/>
      <stop offset="42%" stop-color="#3a67b4"/>
      <stop offset="100%" stop-color="#1f3d7d"/>
    </linearGradient>
    <linearGradient id="ffHairTip" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#3f6bb5"/>
      <stop offset="100%" stop-color="#2f5aa8"/>
    </linearGradient>
    <linearGradient id="ffSkin" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffeee6"/>
      <stop offset="100%" stop-color="#ffd8cb"/>
    </linearGradient>
    <linearGradient id="ffDress" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2c3f78"/>
      <stop offset="100%" stop-color="#18234c"/>
    </linearGradient>
    <linearGradient id="ffApron" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#e6edf7"/>
    </linearGradient>
    <linearGradient id="ffBowl" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#c6d3e3"/>
    </linearGradient>
    <radialGradient id="ffIris" cx="45%" cy="35%" r="75%">
      <stop offset="0%" stop-color="#7fc0f5"/>
      <stop offset="55%" stop-color="#3f8fe0"/>
      <stop offset="100%" stop-color="#123a72"/>
    </radialGradient>
  </defs>

  <!-- ============ 后层：长发（含发尾分叉） ============ -->
  <path d="M100 28C152 28 178 62 178 104C178 146 168 176 154 188
           C161 158 157 128 150 110
           C143 132 126 145 100 145C74 145 57 132 50 110
           C43 128 39 158 46 188
           C32 176 22 146 22 104C22 62 48 28 100 28Z"
        fill="url(#ffHair)" stroke="#152a5e" stroke-width="2.6" stroke-linejoin="round"/>
  <path d="M47 118C51 142 52 164 48 182M153 118C149 142 148 164 152 182"
        fill="none" stroke="#7db4ea" stroke-width="3.2" stroke-linecap="round" opacity="0.5"/>
  <path d="M36 100C38 126 42 150 40 170M164 100C162 126 158 150 160 170"
        fill="none" stroke="#1a3468" stroke-width="2.4" stroke-linecap="round" opacity="0.55"/>

  <!-- ============ 鲸鱼尾巴（身后右侧） ============ -->
  <g transform="translate(163,150) rotate(8)">
    <path d="M0 0C15 -17 32 -21 36 -8C38 -1 27 6 19 8C30 12 36 21 29 29C21 36 6 21 0 6Z"
          fill="#2b4a8f" stroke="#152a5e" stroke-width="2.5" stroke-linejoin="round"/>
  </g>

  <!-- ============ 鲸鱼鳍"耳朵"（尾鳍形，蓝底浅边） ============ -->
  <g transform="translate(60,80) rotate(-16)">
    <path d="M2 0C-18 -16 -40 -12 -44 4C-47 18 -32 28 -16 22C-27 33 -22 46 -9 48C6 50 16 30 10 12Z"
          fill="#3a67b4" stroke="#152a5e" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="M-10 4C-20 -1 -30 0 -35 6" fill="none" stroke="#a8cdf0" stroke-width="2.4" stroke-linecap="round" opacity="0.85"/>
  </g>
  <g transform="translate(140,80) scale(-1,1) rotate(-16)">
    <path d="M2 0C-18 -16 -40 -12 -44 4C-47 18 -32 28 -16 22C-27 33 -22 46 -9 48C6 50 16 30 10 12Z"
          fill="#3a67b4" stroke="#152a5e" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="M-10 4C-20 -1 -30 0 -35 6" fill="none" stroke="#a8cdf0" stroke-width="2.4" stroke-linecap="round" opacity="0.85"/>
  </g>

  <!-- ============ 脖子 ============ -->
  <path d="M86 116H114V134C114 138 110 141 100 141C90 141 86 138 86 134Z"
        fill="#ffd8cb" stroke="#152a5e" stroke-width="2.2"/>

  <!-- ============ 身体：藏青女仆装 ============ -->
  <path d="M100 128C128 128 150 142 156 164L164 196L36 196L44 164C50 142 72 128 100 128Z"
        fill="url(#ffDress)" stroke="#152a5e" stroke-width="2.6" stroke-linejoin="round"/>
  <!-- 白色围裙肩带 -->
  <path d="M80 132C87 128 93 127 100 127C107 127 113 128 120 132"
        fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round"/>
  <!-- 袖口 -->
  <path d="M50 158C37 163 33 176 42 186C50 194 62 190 65 179Z"
        fill="url(#ffDress)" stroke="#152a5e" stroke-width="2.3" stroke-linejoin="round"/>
  <path d="M150 158C163 163 167 176 158 186C150 194 138 190 135 179Z"
        fill="url(#ffDress)" stroke="#152a5e" stroke-width="2.3" stroke-linejoin="round"/>
  <path d="M40 182C47 187 56 185 61 178" fill="none" stroke="#ffffff" stroke-width="4.5" stroke-linecap="round" opacity="0.92"/>
  <path d="M160 182C153 187 144 185 139 178" fill="none" stroke="#ffffff" stroke-width="4.5" stroke-linecap="round" opacity="0.92"/>

  <!-- ============ 围裙 + 小蓝鲸 ============ -->
  <path d="M78 148H122L126 192H74Z"
        fill="url(#ffApron)" stroke="#152a5e" stroke-width="2.3" stroke-linejoin="round"/>
  <path d="M74 192Q79 200 84 192Q89 200 94 192Q99 200 104 192Q109 200 114 192Q119 200 126 192"
        fill="none" stroke="#152a5e" stroke-width="2" stroke-linejoin="round"/>
  <g transform="translate(89.8,157.5) scale(0.88)">
    <path d="${WHALE_BODY} ${WHALE_EYE}" fill-rule="evenodd" clip-rule="evenodd" fill="#3f8fe0"/>
  </g>

  <!-- ============ 脸 ============ -->
  <ellipse cx="100" cy="88" rx="37" ry="36" fill="url(#ffSkin)" stroke="#152a5e" stroke-width="2.6"/>

  <!-- ============ 刘海：锯齿发梢，压到眼睛上方 ============ -->
  <path d="M60 92C56 54 76 32 100 32C124 32 144 54 140 92
           L133 72L126 84L117 68L108 82L100 64L92 82L83 68L74 84L67 72Z"
        fill="url(#ffHair)" stroke="#152a5e" stroke-width="2.4" stroke-linejoin="round"/>
  <!-- 头顶高光 -->
  <path d="M78 46C86 38 94 35 102 35" fill="none" stroke="#8cc2f2" stroke-width="3.4" stroke-linecap="round" opacity="0.65"/>

  <!-- ============ 女仆头饰：蕾丝荷叶边（贴着头的弧带 + 小扇贝） ============ -->
  <path d="M61 60C70 36 130 36 139 60C136 52 128 47 118 46C108 45 92 45 82 46C72 47 64 52 61 60Z"
        fill="#ffffff" stroke="#152a5e" stroke-width="2.2" stroke-linejoin="round"/>
  <path d="M63 58Q70 50 78 52Q84 44 92 50Q100 42 108 50Q116 44 122 52Q130 50 137 58
           Q130 66 122 60Q116 68 108 62Q100 70 92 62Q84 68 78 60Q70 66 63 58Z"
        fill="#ffffff" stroke="#152a5e" stroke-width="2" stroke-linejoin="round"/>

  <!-- ============ 侧面小蝴蝶结 ============ -->
  <g transform="translate(146,66) rotate(-10)">
    <path d="M0 0L-15 -9L-15 10Z" fill="#5aa0e8" stroke="#152a5e" stroke-width="2" stroke-linejoin="round"/>
    <path d="M0 0L15 -9L15 10Z" fill="#5aa0e8" stroke="#152a5e" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="0" cy="0.5" r="4.2" fill="#8fc4ef" stroke="#152a5e" stroke-width="2"/>
  </g>

  <!-- ============ 眼睛 ============ -->
  <ellipse cx="82" cy="99" rx="11.5" ry="13.5" fill="#123a72"/>
  <ellipse cx="118" cy="99" rx="11.5" ry="13.5" fill="#123a72"/>
  <ellipse cx="82" cy="100.5" rx="9" ry="11" fill="url(#ffIris)"/>
  <ellipse cx="118" cy="100.5" rx="9" ry="11" fill="url(#ffIris)"/>
  <circle cx="77.8" cy="93.5" r="4.3" fill="#ffffff"/>
  <circle cx="113.8" cy="93.5" r="4.3" fill="#ffffff"/>
  <circle cx="86" cy="106" r="2.3" fill="#ffffff" opacity="0.9"/>
  <circle cx="122" cy="106" r="2.3" fill="#ffffff" opacity="0.9"/>

  <!-- ============ 腮红 ============ -->
  <ellipse cx="66" cy="112" rx="9.5" ry="5.5" fill="#ff9db0" opacity="0.5"/>
  <ellipse cx="134" cy="112" rx="9.5" ry="5.5" fill="#ff9db0" opacity="0.5"/>

  <!-- ============ 嘴 ============ -->
  <path d="M94 116C97 122 103 122 106 116Z"
        fill="#d4647d" stroke="#152a5e" stroke-width="1.9" stroke-linejoin="round"/>

  <!-- ============ 端着的白饭碗 ============ -->
  <g transform="translate(100,190)">
    <path d="M-30 -2C-30 18 -17 29 0 29C17 29 30 18 30 -2Z"
          fill="url(#ffBowl)" stroke="#152a5e" stroke-width="2.8" stroke-linejoin="round"/>
    <ellipse cx="0" cy="-2" rx="30" ry="9" fill="#ffffff" stroke="#152a5e" stroke-width="2.8"/>
    <!-- 米饭：三坨小堆，别糊成一整个白蛋 -->
    <path d="M-24 -4C-22 -15 -15 -19 -9 -17C-5 -22 5 -22 9 -17C15 -19 22 -15 24 -4C16 1 -16 1 -24 -4Z"
          fill="#ffffff" stroke="#152a5e" stroke-width="2.1"/>
    <path d="M-12 -15C-9 -18 -4 -19 0 -18M4 -18C8 -19 12 -17 14 -14"
          fill="none" stroke="#c6d3e3" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M-9 -21C-13 -28 -4 -32 -9 -39" fill="none" stroke="#9fc4e6" stroke-width="2.4" stroke-linecap="round" opacity="0.9">
      <animate attributeName="opacity" values="0.9;0.2;0.9" dur="2.6s" repeatCount="indefinite"/>
    </path>
    <path d="M8 -22C4 -30 13 -34 8 -42" fill="none" stroke="#9fc4e6" stroke-width="2.4" stroke-linecap="round" opacity="0.65">
      <animate attributeName="opacity" values="0.65;0.12;0.65" dur="3.2s" repeatCount="indefinite"/>
    </path>
  </g>
</svg>`;
}

/**
 * 侧栏图标：单色、跟随 currentColor。
 * 注意浏览器端是**内联**渲染这份路径的（见 lib/client.js）——
 * 用 <img src="...svg"> 加载的 SVG 拿不到页面的 currentColor，
 * 描边会退回黑色，深色侧栏上就看不见了。
 */
export function iconSvg(size = 18) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true" focusable="false">
  <path d="${WHALE_BODY} ${WHALE_EYE}" fill-rule="evenodd" clip-rule="evenodd"/>
  <path d="M11.2 1.1C12 1.1 12.7 1.8 12.7 2.6C12.7 3.4 12 4.1 11.2 4.1C10.4 4.1 9.7 3.4 9.7 2.6C9.7 1.8 10.4 1.1 11.2 1.1Z"/>
  <path d="M7.6 3.3C8.2 3.3 8.7 3.8 8.7 4.4C8.7 5 8.2 5.5 7.6 5.5C7 5.5 6.5 5 6.5 4.4C6.5 3.8 7 3.3 7.6 3.3Z"/>
</svg>`;
}

/** 暴露给测试/工具用 */
export const WHALE_PATHS = { body: WHALE_BODY, eye: WHALE_EYE };
