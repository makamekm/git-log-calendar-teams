const spawn = require('spawnback');

function GitRepository(path) {
  this.path = path;
}

GitRepository.parsePerson = (function() {
  const rPerson = /^(\S+)\s(.+)$/;

  return function(person) {
    const matches = rPerson.exec(person);
    return {
      email: matches[1],
      name: matches[2]
    };
  };
})();

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

GitRepository.prototype.activeDays = async function(checkAuthor, ...args) {
  const dates = await this.exec('log', '--format="%at %ae %an"', ...args);
  const dateMap = {};

  dates
    .split('\n')
    .sort()
    .forEach(line => {
      line = line.replace(/\"/gi, '');
      let [timestamp, email, ...author] = line.split(' ');
      author = author.join(' ').replace(/\"/gi, '');

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
      dateMap[date]++;
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
      return Object.keys(GitRepository.parsePerson(author), {
        commits,
        commitsPercent: ((commits * 100) / totalCommits).toFixed(1)
      });
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
