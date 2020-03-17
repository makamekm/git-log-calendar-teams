const spawn = require('spawnback');

function GitRepository(path) {
  this.path = path;
}

GitRepository.clone = async function(options) {
  const repo = new GitRepository(options.dir);

  const args = ['clone', options.repo];
  options = { ...options };
  delete options.repo;
  delete options.dir;

  Object.keys(options).forEach(option => {
    args.push('--' + option);
    const value = options[option];
    if (value !== true) {
      args.push(value);
    }
  });

  args.push('.');

  await repo.exec(...args);
  return repo;
};

GitRepository.prototype.exec = async function(...args) {
  return new Promise((r, e) =>
    spawn('git', args, { cwd: this.path }, (error, stdout) => {
      if (error) {
        return e(error);
      }
      r(stdout.replace(/\n$/, ''));
    })
  );
};

GitRepository.prototype.activeDays = async function(checkAuthor, sum, ...args) {
  const dates = await this.exec('log', '--format="__brln__ %at %ae %an"', '--find-renames', '--no-renames', '--numstat', ...args);
  const dateMap = {};

  dates
    .replace(/\"/gi, '')
    .split('__brln__ ')
    .sort()
    .forEach(lines => {
      lines = lines.split('\n');
      const [line, _, ...lns] = lines;
      let filesChanged = 0;
      let linesAdded = 0;
      let linesDeleted = 0;
      let linesChanged = 0;
      lns.forEach(ln => {
        ln = ln.split('\t');
        if (ln[0]) {
          filesChanged++;
          linesAdded += Number(ln[0]);
          linesDeleted += Number(ln[1]);
          linesChanged += Number(ln[0]) + Number(ln[1]);
        }
      });
      let [timestamp, email, ...author] = line.split(' ');
      author = author.join(' ').trim();

      if (!timestamp || !(checkAuthor && checkAuthor(email, author))) {
        return;
      }

      let date = new Date(timestamp * 1000);
      const year = date.getFullYear();
      const month = date.getMonth() + 1;
      const day = date.getDate();

      date = year + '-' + (month < 10 ? '0' : '') + month + '-' + (day < 10 ? '0' : '') + day;

      if (!dateMap[date]) {
        dateMap[date] = 0;
      }

      dateMap[date] += sum({
        linesAdded,
        linesDeleted,
        linesChanged,
        filesChanged,
        email,
        author,
        date
      });
    });

  return dateMap;
};

GitRepository.prototype.age = async function() {
  const data = await this.exec('log', '--reverse', '--format=%cr');
  return data.split('\n')[0].replace(/\sago/, '');
};

GitRepository.prototype.remote = async function() {
  await this.exec('remote');
  await this.fetch();
};

GitRepository.prototype.checkout = async function(branch) {
  await this.remote();
  await this.reset();
  const branches = await this.localBranches();
  if (branches.includes(branch)) {
    await this.exec('checkout', `${branch}`);
  } else {
    await this.exec('checkout', '-b', `${branch}`, `origin/${branch}`);
  }
  await this.pull();
};

GitRepository.prototype.localBranches = async function() {
  const data = await this.exec('branch', '--list');
  return data.split('\n').map(s => s.replace(/\*/gi, '').trim());
};

GitRepository.prototype.fetch = async function() {
  await this.exec('fetch', 'origin');
};

GitRepository.prototype.pull = async function() {
  await this.exec('pull', '--force');
};

GitRepository.prototype.reset = async function() {
  await this.exec('reset', '--hard', 'HEAD');
};

GitRepository.prototype.authors = async function(...args) {
  const data = await this.exec('log', '--format=%aE %aN', ...args);

  let authors = data.length ? data.split('\n') : [];
  const authorMap = {};
  let totalCommits = 0;

  authors.forEach(author => {
    if (!authorMap[author]) {
      authorMap[author] = 0;
    }

    authorMap[author]++;
    totalCommits++;
  });

  authors = Object.keys(authorMap)
    .map(author => {
      const commits = authorMap[author];
      let [email, ...name] = author.split(' ');
      name = name.join(' ').trim();
      return {
        email,
        name,
        commits,
        commitsPercent: ((commits * 100) / totalCommits).toFixed(1)
      };
    })
    .sort((a, b) => {
      return b.commits - a.commits;
    });

  return authors;
};

GitRepository.prototype.isGitRepository = async function() {
  try {
    await this.exec('rev-parse', '--git-dir');
    return true;
  } catch (error) {
    if (error.message.indexOf('Not a git repository')) {
      return false;
    }

    // If the path doesn't exist, don't return an error
    if (error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
};

module.exports = GitRepository;
