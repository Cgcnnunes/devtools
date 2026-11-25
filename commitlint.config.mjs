export default {
  defaultIgnores: false,
  plugins: [
    {
      rules: {
        "dev-message-format": ({ raw }) => {
          const message = raw.replace(/(?:\r?\n)+$/, "");
          return [
            message.length <= 120 &&
              /^(feat|fix|doc|chore): DEV-[0-9]{5} \S[^\r\n]*$/.test(message),
            "use <feat|fix|doc|chore>: DEV-00000 <description> on one line, at most 120 characters",
          ];
        },
      },
    },
  ],
  rules: {
    "dev-message-format": [2, "always"],
  },
};
