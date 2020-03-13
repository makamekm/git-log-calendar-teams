var spawn = require('spawnback');

function Repo(path) {
  this.path = path;
}

Repo.parsePerson = (function() {
  var rPerson = /^(\S+)\s(.+)$/;

  return function(person) {
    var matches = rPerson.exec(person);
    return {
      email: matches[1],
      name: matches[2]
    };
  };
})();

Repo.clone = async function(options) {
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

  const repo = new Repo(dir);
  await repo.exec(args);
  return repo;
};

Repo.prototype.exec = async function() {
  var args = [].slice.call(arguments);
  return new Promise((r, e) =>
    spawn('git', args, { cwd: this.path }, (error, stdout) => {
      if (error) {
        return e(error);
      }

      // Remove trailing newline
      stdout = stdout.replace(/\n$/, '');

      r(stdout);
    })
  );
};

Repo.prototype.activeDays = async function(checkAuthor, ...committish) {
  const dates = await this.exec('log', '--format="%at %ae %an"', '--all', '--no-merges', ...committish);
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

      var date = new Date(timestamp * 1000);
      var year = date.getFullYear();
      var month = date.getMonth() + 1;
      var day = date.getDate();

      date = year + '-' + (month < 10 ? '0' : '') + month + '-' + (day < 10 ? '0' : '') + day;

      if (!dateMap[date]) {
        dateMap[date] = 0;
      }
      dateMap[date]++;
    });

  return dateMap;
};

Repo.prototype.age = async function() {
  const data = await this.exec('log', '--reverse', '--format=%cr');
  return data.split('\n')[0].replace(/\sago/, '');
};

Repo.prototype.authors = async function(...committish) {
  const data = await this.exec('log', '--format=%aE %aN', ...committish);

  // Logs on a boundary commit will have no output
  var authors = data.length ? data.split('\n') : [];
  var authorMap = {};
  var totalCommits = 0;

  authors.forEach(function(author) {
    if (!authorMap[author]) {
      authorMap[author] = 0;
    }

    authorMap[author]++;
    totalCommits++;
  });

  authors = Object.keys(authorMap)
    .map(function(author) {
      var commits = authorMap[author];
      return Object.keys(Repo.parsePerson(author), {
        commits: commits,
        commitsPercent: ((commits * 100) / totalCommits).toFixed(1)
      });
    })
    .sort(function(a, b) {
      return b.commits - a.commits;
    });

  return authors;
};

Repo.prototype.isRepo = async function() {
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

module.exports = Repo;
